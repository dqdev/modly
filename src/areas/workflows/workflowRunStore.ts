import { create } from 'zustand'
import axios, { AxiosInstance } from 'axios'
import { useAppStore } from '@shared/stores/appStore'
import { getServerModelInfo } from '@shared/stores/serverModelsStore'
import { getWorkflowExtension } from './mockExtensions'
import type { WorkflowExtension } from './mockExtensions'
import type { Workflow, WFNode, WFEdge } from '@shared/types/electron.d'
import { isBranchStarter, isSceneOutput, resolveDataSource, reachesSceneOutput, nearestUpstreamWaits } from './nodeBehaviors'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRunState {
  status:        'idle' | 'running' | 'paused' | 'done' | 'error'
  blockIndex:    number
  blockTotal:    number
  blockProgress: number
  blockStep:     string
  outputUrl?:    string
  outputPath?:   string
  error?:        string
}

export type WaitState = 'blocked' | 'pending' | 'running' | 'done' | 'error'

const IDLE: WorkflowRunState = {
  status: 'idle', blockIndex: 0, blockTotal: 0, blockProgress: 0, blockStep: '',
}

// ─── Module-level run context (survives between run() and continueRun(id)) ───

const _cancel      = { current: false }
const _activeJobId = { current: null as string | null }

interface NodeOutput { filePath?: string; text?: string; outputType?: string; serverUrl?: string }

interface RunContext {
  workflow:           Workflow
  allExtensions:      WorkflowExtension[]
  client:             AxiosInstance
  workspaceDir:       string
  selectedImagePath:  string | undefined
  selectedImageData?: string
  overrideImageData?: string
  nodeOutputs:        Map<string, NodeOutput>
  nodeMap:            Map<string, WFNode>
  /** nodes in execution (topological) order */
  ordered:            WFNode[]
  branches:           Map<string, WFNode[]>
  waitIds:            string[]
  /** waitId → nearest upstream waitId (null = top-level, runnable from the start) */
  parentWait:         Map<string, string | null>
  /** workspace URL of the most recently pushed scene mesh (last branch the user ran wins) */
  lastSceneMesh?:     string
}
const _ctx = { current: null as RunContext | null }

// ─── Topological sort (DFS preorder, branch-first) ───────────────────────────

function topoSort(nodes: WFNode[], edges: WFEdge[]): WFNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const adj     = new Map(nodes.map((n) => [n.id, [] as string[]]))
  const inDeg   = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
  }

  const visited = new Set<string>()
  const result: WFNode[] = []

  const visit = (id: string): void => {
    if (visited.has(id)) return
    for (const e of edges) {
      if (e.target === id && !visited.has(e.source) && nodeMap.has(e.source)) return
    }
    const node = nodeMap.get(id)
    if (!node) return
    visited.add(id)
    result.push(node)
    for (const childId of adj.get(id) ?? []) visit(childId)
  }

  for (const node of nodes) if ((inDeg.get(node.id) ?? 0) === 0) visit(node.id)
  for (const node of nodes) if (!visited.has(node.id)) visit(node.id)
  return result
}

// ─── Branch identification ────────────────────────────────────────────────────
// A node belongs to Wait W's branch if its single nearest upstream Wait is W
// (dominance). Nodes with no upstream Wait — or with multiple (merges) — execute
// in the pre-phase before any user pause.

function identifyBranches(workflow: Workflow): {
  preExecExtNodes: WFNode[]
  branches:        Map<string, WFNode[]>
  waitIds:         string[]
  parentWait:      Map<string, string | null>
  ordered:         WFNode[]
} {
  const ordered = topoSort(workflow.nodes, workflow.edges)
  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))
  const waitIds = ordered.filter((n) => isBranchStarter(n.type)).map((n) => n.id)

  // A node is owned by its single nearest upstream Wait (dominance). This lets
  // Wait → … → Wait chains nest: nodes after the 2nd Wait belong to it, not the 1st.
  const branchOwner = new Map<string, string>()
  for (const node of workflow.nodes) {
    if (isBranchStarter(node.type)) continue
    const nearest = nearestUpstreamWaits(node.id, workflow.edges, nodeMap)
    if (nearest.size === 1) branchOwner.set(node.id, [...nearest][0])
  }

  // Each Wait's parent = its own nearest upstream Wait (null if top-level).
  const parentWait = new Map<string, string | null>()
  for (const w of waitIds) {
    const nearest = nearestUpstreamWaits(w, workflow.edges, nodeMap)
    parentWait.set(w, nearest.size === 1 ? [...nearest][0] : null)
  }

  const branches = new Map<string, WFNode[]>()
  for (const w of waitIds) branches.set(w, [])
  const preExecExtNodes: WFNode[] = []
  for (const node of ordered) {
    if ((node.type !== 'extensionNode' && node.type !== 'serverNode') || !node.data.enabled) continue
    const owner = branchOwner.get(node.id)
    if (owner) branches.get(owner)!.push(node)
    else preExecExtNodes.push(node)
  }

  return { preExecExtNodes, branches, waitIds, parentWait, ordered }
}

// Some node outputs carry the API server's workspace-relative path re-based onto
// our local workspaceDir (see runModelJob's return value below) — real on disk
// only when the API happens to run on this machine; with a remote API (see
// PYTHON_API_URL) the file exists only on the server's disk. Others (a process-
// extension's own result) are already genuinely local. Both look identical as
// strings, so check the disk rather than guess: if it's not there, treat it as
// the former and fetch it over HTTP before handing it to a local consumer
// (process-extension subprocess, fs:readFileBase64).
async function ensureLocalFile(path: string, workspaceDir: string): Promise<string> {
  if (await window.electron.fs.exists(path)) return path
  const norm = path.replace(/\\/g, '/')
  if (!norm.startsWith(workspaceDir)) throw new Error(`File not found: ${path}`)
  const rel = norm.slice(workspaceDir.length).replace(/^\//, '')
  const dl = await window.electron.fs.downloadWorkspaceFile(`/workspace/${rel}`)
  if (!dl.success || !dl.localPath) throw new Error(dl.error ?? `Failed to fetch generated file: ${rel}`)
  return dl.localPath
}

// A model node's `mesh_path` param is read by the generator on the API server's
// own filesystem, so a path is only usable there if the file exists there. Mesh
// outputs that came from the API (model generation) already do; ones produced on
// this machine (a process extension's output, a mesh the user picked) never do,
// and with a remote API (see PYTHON_API_URL) a re-based workspace path silently
// points at nothing. Same ambiguity as ensureLocalFile, resolved the same way:
// ask rather than guess — probe the server, and upload only when it comes up short.
async function ensureServerMesh(filePath: string, ctx: RunContext): Promise<string> {
  const norm = filePath.replace(/\\/g, '/')
  const rel  = norm.startsWith(ctx.workspaceDir)
    ? norm.slice(ctx.workspaceDir.length).replace(/^\//, '')
    : undefined

  if (rel) {
    try {
      await ctx.client.head(`/workspace/${rel}`)
      return rel
    } catch { /* 404 — the server doesn't have it; upload below */ }
  }

  const local  = await ensureLocalFile(filePath, ctx.workspaceDir)
  const base64 = await window.electron.fs.readFileBase64(local)
  const bytes  = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const fd     = new FormData()
  fd.append('mesh', new Blob([bytes]), local.split(/[\\/]/).pop() ?? 'mesh.glb')
  const { data } = await ctx.client.post<{ path: string }>(
    '/generate/upload-mesh', fd, { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data.path
}

// The inverse: a node output that IS real on local disk (a process-extension
// result) but that the API server — which may be remote — has never seen, so a
// naive `/workspace/<rel>` URL 404s when the viewer or a downstream export tries
// to fetch it. `isServerNative` is true for outputs that came from the API
// itself (model generation), which are always already reachable at that URL.
async function resolveServerUrl(
  filePath:       string,
  ctx:            RunContext,
  isServerNative: boolean,
): Promise<string | undefined> {
  const norm = filePath.replace(/\\/g, '/')
  if (!norm.startsWith(ctx.workspaceDir)) return undefined
  const rel = norm.slice(ctx.workspaceDir.length).replace(/^\//, '')
  if (isServerNative) return `/workspace/${rel}`

  const base64 = await window.electron.fs.readFileBase64(filePath)
  const bytes  = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const ext    = filePath.split('.').pop() ?? 'glb'
  const fd     = new FormData()
  fd.append('file', new Blob([bytes]), `mesh.${ext}`)
  const { data } = await ctx.client.post<{ url: string }>(
    '/optimize/import-upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  return data.url
}

// ─── Model generation job (shared by ExtensionNode's model branch and ServerNode) ──
// Submits an image to /generate/from-image and polls /generate/status until it
// finishes, returning the local absolute path of the resulting mesh.

async function runModelJob(
  client:       AxiosInstance,
  modelId:      string,
  imageBlob:    Blob,
  filename:     string,
  params:       Record<string, unknown>,
  workspaceDir: string,
  setRunState:  (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
  startStep:    string,
): Promise<string> {
  const fd = new FormData()
  fd.append('image', imageBlob, filename)
  fd.append('model_id', modelId)
  fd.append('collection', 'Workflows')
  fd.append('remesh', 'none')
  fd.append('enable_texture', 'false')
  fd.append('texture_resolution', '1024')
  fd.append('params', JSON.stringify(params))

  setRunState((s) => ({ ...s, blockProgress: 5, blockStep: startStep }))

  const { data } = await client.post<{ job_id: string }>(
    '/generate/from-image', fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  )
  _activeJobId.current = data.job_id

  while (true) {
    if (_cancel.current) {
      await client.post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
      _activeJobId.current = null
      throw new Error('Cancelled')
    }
    await new Promise((r) => setTimeout(r, 1200))

    const { data: st } = await client.get<{
      status: string; progress?: number; step?: string; output_url?: string; error?: string
    }>(`/generate/status/${_activeJobId.current}`)

    if (st.status === 'done' && st.output_url) {
      const rel = st.output_url.replace(/^\/workspace\//, '')
      _activeJobId.current = null
      setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Generation complete' }))
      return `${workspaceDir}/${rel}`
    }
    if (st.status === 'error') throw new Error(st.error ?? 'Generation failed')

    setRunState((s) => ({ ...s, blockProgress: st.progress ?? s.blockProgress, blockStep: st.step ?? 'Generating…' }))
    useAppStore.getState().updateCurrentJob({ status: 'generating', progress: st.progress, step: st.step })
  }
}

// ─── Per-node execution ──────────────────────────────────────────────────────
// Resolves inputs (walking through Wait passthroughs), runs the extension
// (model or process), updates nodeOutputs, and pushes the mesh to the scene
// if it feeds an Add-to-Scene through Waits.

async function executeExtensionNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  const { workflow, allExtensions, client, workspaceDir, nodeOutputs, nodeMap,
          selectedImagePath, selectedImageData } = ctx

  const ext = getWorkflowExtension(node.data.extensionId ?? '', allExtensions)

  const resolveSource = (sourceId: string): NodeOutput | undefined => {
    const realId = resolveDataSource(sourceId, workflow.edges, nodeMap)
    return realId ? nodeOutputs.get(realId) : undefined
  }

  let nodeInputPath:     string | undefined
  let nodeInputText:     string | undefined
  let nodeInputMeshPath: string | undefined

  const incomingEdges = workflow.edges.filter((e) => e.target === node.id)

  if (ext?.inputs && ext.inputs.length > 1) {
    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (!src) continue
      if (src.outputType === 'mesh')        nodeInputMeshPath = src.filePath
      else if (src.outputType === 'image')  nodeInputPath     = src.filePath
      else if (src.filePath !== undefined)  nodeInputPath     = src.filePath
      if (src.text !== undefined)           nodeInputText     = src.text
    }
  } else {
    for (const edge of incomingEdges) {
      const src = resolveSource(edge.source)
      if (src?.filePath !== undefined) nodeInputPath = src.filePath
      if (src?.text     !== undefined) nodeInputText = src.text
    }
  }

  const isModelNode = ext?.type === 'model'

  if (isModelNode) {
    const activeImagePath = nodeInputPath ?? selectedImagePath
    if (!selectedImageData && (!activeImagePath || activeImagePath.trim().length === 0)) {
      throw new Error('No input image selected for model node')
    }
    const base64 = selectedImageData && nodeInputPath === undefined
      ? selectedImageData
      : await window.electron.fs.readFileBase64(await ensureLocalFile(activeImagePath as string, workspaceDir))
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob  = new Blob([bytes], { type: 'image/png' })
    const fname = activeImagePath?.split(/[\\/]/).pop() ?? 'image.png'

    const extraParams: Record<string, unknown> = {}
    if (nodeInputMeshPath) {
      extraParams.mesh_path = await ensureServerMesh(nodeInputMeshPath, ctx)
    }

    const schemaDefaults = Object.fromEntries(
      (ext.params ?? []).map((p) => [p.id, p.default]),
    )
    const effectiveParams = { ...schemaDefaults, ...(node.data.params ?? {}) }

    nodeInputPath = await runModelJob(
      client, node.data.extensionId ?? '', blob, fname,
      { ...effectiveParams, ...extraParams }, workspaceDir, setRunState, 'Submitting to model…',
    )
  } else {
    if (ext?.input === 'mesh'  && !nodeInputPath) throw new Error(`${ext.name} needs an incoming mesh connection`)
    if (ext?.input === 'image' && !nodeInputPath) throw new Error(`${ext.name} needs an incoming image connection`)
    if (ext?.input === 'text'  && !nodeInputText) throw new Error(`${ext.name} needs an incoming text connection`)

    const parts  = (node.data.extensionId ?? '').split('/')
    const extId  = parts[0]
    const nid    = parts[1] ?? ''
    const localInputPath = nodeInputPath ? await ensureLocalFile(nodeInputPath, workspaceDir) : nodeInputPath
    const result = await window.electron.extensions.runProcess(
      extId,
      { filePath: localInputPath, text: nodeInputText, nodeId: nid },
      node.data.params as Record<string, unknown>,
    )
    if (!result.success) throw new Error(result.error ?? 'Process extension failed')
    nodeInputPath = result.result?.filePath ?? nodeInputPath
    nodeInputText = result.result?.text     ?? nodeInputText
    setRunState((s) => ({ ...s, blockProgress: 100, blockStep: 'Done' }))
  }

  const outputType = ext?.output ?? (nodeInputPath ? 'mesh' : undefined)
  const serverUrl  = nodeInputPath ? await resolveServerUrl(nodeInputPath, ctx, isModelNode) : undefined
  nodeOutputs.set(node.id, { filePath: nodeInputPath, text: nodeInputText, outputType, serverUrl })

  if (serverUrl && reachesSceneOutput(node.id, workflow.edges, nodeMap)) {
    ctx.lastSceneMesh = serverUrl   // remember it so finalize() keeps the last-run branch in view
    useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl: serverUrl })
  }
}

// ─── ServerNode execution ──────────────────────────────────────────────────────
// Same image→mesh flow as a model ExtensionNode, but the model is picked from
// the node's own dropdown (backed by the local server's model registry) rather
// than from an installed extension — the server auto-downloads/loads it.

async function executeServerNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  const { workflow, client, workspaceDir, nodeOutputs, nodeMap, selectedImagePath, selectedImageData } = ctx

  const resolveSource = (sourceId: string): NodeOutput | undefined => {
    const realId = resolveDataSource(sourceId, workflow.edges, nodeMap)
    return realId ? nodeOutputs.get(realId) : undefined
  }

  // A server-registry model may declare multiple inputs (e.g. Trellis 2's
  // Texture Mesh node: image + mesh) — resolve each incoming edge by the
  // upstream node's output type rather than assuming a single image input.
  let nodeInputPath:     string | undefined
  let nodeInputMeshPath: string | undefined
  for (const edge of workflow.edges.filter((e) => e.target === node.id)) {
    const src = resolveSource(edge.source)
    if (!src) continue
    if (src.outputType === 'mesh')       nodeInputMeshPath = src.filePath
    else if (src.outputType === 'image') nodeInputPath     = src.filePath
    else if (src.filePath !== undefined) nodeInputPath     = src.filePath
  }

  const modelId = (node.data.params?.modelId as string | undefined) ?? ''
  if (!modelId) throw new Error('Server node has no model selected')

  const activeImagePath = nodeInputPath ?? selectedImagePath
  if (!selectedImageData && (!activeImagePath || activeImagePath.trim().length === 0)) {
    throw new Error('No input image selected for Server node')
  }
  const base64 = selectedImageData && nodeInputPath === undefined
    ? selectedImageData
    : await window.electron.fs.readFileBase64(await ensureLocalFile(activeImagePath as string, workspaceDir))
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const blob  = new Blob([bytes], { type: 'image/png' })
  const fname = activeImagePath?.split(/[\\/]/).pop() ?? 'image.png'

  const modelParams = (node.data.params?.modelParams as Record<string, unknown>) ?? {}

  const extraParams: Record<string, unknown> = {}
  if (nodeInputMeshPath) {
    extraParams.mesh_path = await ensureServerMesh(nodeInputMeshPath, ctx)
  }

  nodeInputPath = await runModelJob(
    client, modelId, blob, fname, { ...modelParams, ...extraParams }, workspaceDir, setRunState, 'Submitting to server…',
  )

  const outputType = getServerModelInfo(modelId)?.output ?? 'mesh'
  const serverUrl  = await resolveServerUrl(nodeInputPath, ctx, true)
  nodeOutputs.set(node.id, { filePath: nodeInputPath, outputType, serverUrl })

  if (serverUrl && reachesSceneOutput(node.id, workflow.edges, nodeMap)) {
    ctx.lastSceneMesh = serverUrl
    useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl: serverUrl })
  }
}

function executeNode(
  node:        WFNode,
  ctx:         RunContext,
  setRunState: (updater: (s: WorkflowRunState) => WorkflowRunState) => void,
): Promise<void> {
  return node.type === 'serverNode'
    ? executeServerNode(node, ctx, setRunState)
    : executeExtensionNode(node, ctx, setRunState)
}

// ─── Wait dependency helpers ───────────────────────────────────────────────────

/** All Waits nested (transitively) under `rootId`, via the parentWait chain. */
function descendantWaits(rootId: string, ctx: RunContext): Set<string> {
  const out = new Set<string>()
  let frontier = new Set<string>([rootId])
  while (frontier.size > 0) {
    const next = new Set<string>()
    for (const w of ctx.waitIds) {
      const parent = ctx.parentWait.get(w)
      if (parent && frontier.has(parent) && !out.has(w)) { out.add(w); next.add(w) }
    }
    frontier = next
  }
  return out
}

/**
 * Push the mesh of every scene output owned by `waitId`'s branch to the viewer.
 * A branch whose only scene output has no in-branch processing (e.g. Wait → Add
 * to Scene) gets no immediate push during execution, so the display has to be
 * driven here, when the user continues that branch.
 */
function pushBranchSceneMesh(ctx: RunContext, waitId: string): void {
  for (const node of ctx.ordered) {
    if (!isSceneOutput(node.type)) continue
    const owners = nearestUpstreamWaits(node.id, ctx.workflow.edges, ctx.nodeMap)
    if (owners.size !== 1 || [...owners][0] !== waitId) continue
    const inEdge = ctx.workflow.edges.find((e) => e.target === node.id)
    if (!inEdge) continue
    const srcId = resolveDataSource(inEdge.source, ctx.workflow.edges, ctx.nodeMap)
    const url = srcId ? ctx.nodeOutputs.get(srcId)?.serverUrl : undefined
    if (url) {
      ctx.lastSceneMesh = url
      useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl: url })
    }
  }
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface WorkflowRunStore {
  runState:         WorkflowRunState
  activeNodeId:     string | null
  activeWorkflowId: string | null
  nodeImageOutputs: Record<string, string>
  waitStates:       Record<string, WaitState>
  runningBranchId:  string | null

  run:         (workflow: Workflow, allExtensions: WorkflowExtension[], overrideImageData?: string) => Promise<void>
  cancel:      () => void
  reset:       () => void
  continueRun: (waitId: string) => Promise<void>
}

export const useWorkflowRunStore = create<WorkflowRunStore>((set, get) => {
  const setRunState = (updater: (s: WorkflowRunState) => WorkflowRunState): void => {
    set((s) => ({ runState: updater(s.runState) }))
  }

  const collectImageOutputs = (ctx: RunContext): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [nodeId, o] of ctx.nodeOutputs) {
      if (o.outputType === 'image' && o.filePath) {
        const norm = o.filePath.replace(/\\/g, '/')
        if (norm.startsWith(ctx.workspaceDir)) {
          out[nodeId] = `/workspace/${norm.slice(ctx.workspaceDir.length).replace(/^\//, '')}`
        }
      }
    }
    return out
  }

  const finalize = (ctx: RunContext, finalWaitStates?: Record<string, WaitState>): void => {
    // Prefer the mesh of the last branch the user actually ran — it's already in the
    // viewer, and topo order must not override the user's last action.
    let outputUrl:  string | undefined = ctx.lastSceneMesh
    let outputPath: string | undefined

    const lastOutputNode = outputUrl ? undefined : [...ctx.ordered].reverse().find((n) => isSceneOutput(n.type))
    if (lastOutputNode) {
      for (const edge of ctx.workflow.edges.filter((e) => e.target === lastOutputNode.id)) {
        const src = ctx.nodeOutputs.get(edge.source)
        if (src?.serverUrl) outputUrl = src.serverUrl
      }
    }
    if (!outputUrl) {
      for (const [, o] of ctx.nodeOutputs) {
        if (o.serverUrl) outputUrl = o.serverUrl
        else if (o.filePath) outputPath = o.filePath
      }
    }

    set((s) => ({
      activeNodeId:     null,
      runningBranchId:  null,
      waitStates:       finalWaitStates ?? s.waitStates,
      nodeImageOutputs: collectImageOutputs(ctx),
      runState: {
        status:        'done',
        blockIndex:    0,
        blockTotal:    0,
        blockProgress: 100,
        blockStep:     'Done',
        outputUrl,
        outputPath,
      },
    }))
    useAppStore.getState().updateCurrentJob({ status: 'done', progress: 100, outputUrl })
  }

  return {
    runState:         IDLE,
    activeNodeId:     null,
    activeWorkflowId: null,
    nodeImageOutputs: {},
    waitStates:       {},
    runningBranchId:  null,

    async run(workflow, allExtensions, overrideImageData?) {
      _cancel.current = false

      const appState = useAppStore.getState()
      const apiUrl   = appState.apiUrl

      const { preExecExtNodes, branches, waitIds, parentWait, ordered } = identifyBranches(workflow)
      const branchSteps = waitIds.reduce((acc, w) => acc + (branches.get(w)?.length ?? 0), 0)
      const totalSteps  = preExecExtNodes.length + branchSteps

      const selectedImagePath = appState.selectedImagePath ?? undefined
      const selectedImageData = overrideImageData ?? appState.selectedImageData ?? undefined
      const currentMeshUrl    = appState.currentJob?.outputUrl

      set({
        activeWorkflowId: workflow.id,
        nodeImageOutputs: {},
        // Top-level Waits are pending; nested Waits start blocked until their parent finishes.
        waitStates:       Object.fromEntries(waitIds.map((id) => [id, parentWait.get(id) ? 'blocked' as WaitState : 'pending' as WaitState])),
        runningBranchId:  null,
        runState: {
          status: 'running', blockIndex: 0, blockTotal: totalSteps,
          blockProgress: 0, blockStep: 'Starting…',
        },
      })

      appState.setCurrentJob({
        id:        crypto.randomUUID(),
        imageFile: selectedImagePath ?? '__workflow__',
        status:    'generating',
        progress:  0,
        createdAt: Date.now(),
      })

      try {
        const client       = axios.create({ baseURL: apiUrl })
        const settings     = await window.electron.settings.get()
        const workspaceDir = settings.workspaceDir.replace(/\\/g, '/')

        const tmpAbsPath = settings.workspaceDir.replace(/[\\/]+$/, '') + '/tmp'
        window.electron.fs.deleteDirectory(tmpAbsPath).catch(() => {})

        const nodeOutputs = new Map<string, NodeOutput>()
        const nodeMap     = new Map(workflow.nodes.map((n) => [n.id, n]))

        // Pre-populate source nodes
        for (const node of ordered) {
          if (node.type === 'imageNode') {
            const fp = node.data.params?.filePath as string | undefined
            const resolvedPath = overrideImageData ? undefined : (fp ?? selectedImagePath ?? undefined)
            nodeOutputs.set(node.id, { filePath: resolvedPath, outputType: 'image' })
          }
          if (node.type === 'textNode') {
            nodeOutputs.set(node.id, { text: node.data.params?.text as string | undefined })
          }
          if (node.type === 'meshNode') {
            const source = node.data.params?.source as 'file' | 'current' | undefined
            if (source === 'current' && currentMeshUrl) {
              let meshFilePath: string
              if (currentMeshUrl.includes('serve-file?path=')) {
                const encoded = currentMeshUrl.split('serve-file?path=')[1]
                meshFilePath = decodeURIComponent(encoded).replace(/\\/g, '/')
              } else {
                const rel = currentMeshUrl.replace(/^\/workspace\//, '')
                meshFilePath = `${workspaceDir}/${rel}`
              }
              nodeOutputs.set(node.id, { filePath: meshFilePath, outputType: 'mesh' })
            } else {
              const fp = node.data.params?.filePath as string | undefined
              if (fp) nodeOutputs.set(node.id, { filePath: fp, outputType: 'mesh' })
            }
          }
        }

        const ctx: RunContext = {
          workflow, allExtensions, client, workspaceDir, selectedImagePath, selectedImageData,
          overrideImageData, nodeOutputs, nodeMap, ordered, branches, waitIds, parentWait,
        }
        _ctx.current = ctx

        // Pre-phase: nodes that don't belong to any single branch (sources + merges).
        for (let i = 0; i < preExecExtNodes.length; i++) {
          if (_cancel.current) { _ctx.current = null; set({ runState: IDLE, activeNodeId: null }); return }
          const node = preExecExtNodes[i]
          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
          }))
          await executeNode(node, ctx, setRunState)
        }

        if (waitIds.length > 0) {
          // Hand off to the user — branches run on demand via continueRun(id).
          set((s) => ({
            activeNodeId: null,
            runState: { ...s.runState, status: 'paused', blockStep: 'Pick a branch and click Continue' },
          }))
          return
        }

        finalize(ctx)
      } catch (err) {
        if (!_cancel.current) {
          set((s) => ({ runState: { ...s.runState, status: 'error', error: String(err) }, activeNodeId: null }))
          useAppStore.getState().updateCurrentJob({ status: 'error', error: String(err) })
        }
      }
    },

    async continueRun(waitId) {
      const state = get()
      if (state.runningBranchId !== null) return
      // Only runnable Waits: blocked (parent not done) and running are not.
      const ws = state.waitStates[waitId]
      if (ws !== 'pending' && ws !== 'done' && ws !== 'error') return
      // A pending Wait only runs after a clean handoff. If the run errored in the
      // pre-phase, it never handed off — don't start a branch with missing inputs.
      if (ws === 'pending' && state.runState.status === 'error') return
      const ctx = _ctx.current
      if (!ctx) {
        console.warn('continueRun: no active run context — was the module hot-reloaded mid-run?')
        return
      }

      const branch = ctx.branches.get(waitId) ?? []
      // Re-running a Wait invalidates everything downstream: descendant branches
      // were computed against the old output, so drop their outputs and reset
      // them to blocked until this branch produces a fresh result.
      const descendants = descendantWaits(waitId, ctx)

      _cancel.current = false

      // Reset outputs for this branch's nodes so Retry re-executes cleanly.
      for (const node of branch) ctx.nodeOutputs.delete(node.id)
      for (const d of descendants) for (const node of ctx.branches.get(d) ?? []) ctx.nodeOutputs.delete(node.id)

      set((s) => {
        const waitStates = { ...s.waitStates, [waitId]: 'running' as WaitState }
        for (const d of descendants) waitStates[d] = 'blocked'
        return {
          runningBranchId: waitId,
          waitStates,
          runState: { ...s.runState, status: 'running', blockIndex: 0, blockTotal: branch.length, blockProgress: 0, blockStep: branch.length === 0 ? 'Done' : 'Starting…' },
        }
      })

      const finishBranch = (next: WaitState, err?: string): void => {
        if (_cancel.current) return
        const newWaitStates = { ...get().waitStates, [waitId]: next }
        // Unblock nested Waits whose parent branch just finished, and push this
        // branch's scene output to the viewer.
        if (next === 'done') {
          for (const w of ctx.waitIds) {
            if (ctx.parentWait.get(w) === waitId && newWaitStates[w] === 'blocked') newWaitStates[w] = 'pending'
          }
          pushBranchSceneMesh(ctx, waitId)
        }
        // A failed branch can never feed its descendants — surface them as error
        // too, otherwise they stay 'blocked' and the run hangs on 'paused' forever.
        if (next === 'error') {
          for (const d of descendantWaits(waitId, ctx)) {
            if (newWaitStates[d] === 'blocked') newWaitStates[d] = 'error'
          }
        }
        const allFinished = ctx.waitIds.every((id) => newWaitStates[id] === 'done' || newWaitStates[id] === 'error')
        const anyError    = ctx.waitIds.some((id) => newWaitStates[id] === 'error')

        if (allFinished && !anyError) {
          finalize(ctx, newWaitStates)
        } else {
          set((s) => ({
            activeNodeId:    null,
            runningBranchId: null,
            waitStates:      newWaitStates,
            runState: {
              ...s.runState,
              status:    allFinished ? 'error' : 'paused',
              error:     anyError ? (err ?? s.runState.error) : undefined,
              blockStep: err ? `Branch failed: ${err}` : 'Pick a branch and click Continue',
            },
          }))
        }
      }

      try {
        for (let i = 0; i < branch.length; i++) {
          if (_cancel.current) return
          const node = branch[i]
          set((s) => ({
            activeNodeId: node.id,
            runState: { ...s.runState, blockIndex: i, blockProgress: 0, blockStep: 'Starting…' },
          }))
          await executeNode(node, ctx, setRunState)
        }
        finishBranch('done')
      } catch (err) {
        finishBranch('error', String(err))
      }
    },

    cancel() {
      _cancel.current = true
      if (_activeJobId.current) {
        const apiUrl = useAppStore.getState().apiUrl
        axios.create({ baseURL: apiUrl }).post(`/generate/cancel/${_activeJobId.current}`).catch(() => {})
        _activeJobId.current = null
      }
      _ctx.current = null
      set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {}, waitStates: {}, runningBranchId: null })
      useAppStore.getState().setCurrentJob(null)
    },

    reset() {
      _ctx.current = null
      set({ runState: IDLE, activeNodeId: null, activeWorkflowId: null, nodeImageOutputs: {}, waitStates: {}, runningBranchId: null })
    },
  }
})
