import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useAppStore } from '@shared/stores/appStore'
import { useApi } from '@shared/hooks/useApi'
import type { WFNodeData, ParamSchema } from '@shared/types/electron.d'
import { useWorkflowRunStore } from '../workflowRunStore'
import BaseNode from './BaseNode'

// ─── Handle colors ────────────────────────────────────────────────────────────

const HANDLE_COLOR = { image: '#38bdf8', mesh: '#a78bfa' }
const TAG_CLS = {
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  mesh:  'border-violet-500/30 bg-violet-500/10 text-violet-400',
}

const inputCls = 'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'

interface ServerModel { id: string; name: string; downloaded: boolean }

// ─── Small numeric inputs (mirrors ExtensionNode's controls) ──────────────────

function IntInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)
  if (prevValue.current !== value && parseInt(text, 10) !== value) {
    prevValue.current = value
    setText(String(value))
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const raw = e.target.value
        if (raw !== '' && raw !== '-' && !/^-?\d+$/.test(raw)) return
        setText(raw)
        const n = parseInt(raw, 10)
        if (!isNaN(n)) { prevValue.current = n; onChange(n) }
      }}
      className={inputCls}
    />
  )
}

function FloatInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  const prevValue = useRef(value)
  if (prevValue.current !== value && parseFloat(text.replace(',', '.')) !== value) {
    prevValue.current = value
    setText(String(value))
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(',', '.')
        if (raw !== '' && raw !== '-' && raw !== '.' && !/^-?\d*\.?\d*$/.test(raw)) return
        setText(e.target.value)
        const num = parseFloat(raw)
        if (!isNaN(num)) { prevValue.current = num; onChange(num) }
      }}
      className={inputCls}
    />
  )
}

// ─── ServerNode ───────────────────────────────────────────────────────────────
// Calls the local API server directly for image→mesh generation. Unlike
// ExtensionNode, it isn't backed by an installed extension — the model list
// and per-model params come straight from the running server's own registry,
// which auto-downloads/loads whichever model is selected.

export default function ServerNode({ id, data, selected }: { id: string; data: WFNodeData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow()
  const running = useWorkflowRunStore((s) => s.activeNodeId === id)
  const apiUrl  = useAppStore((s) => s.apiUrl)
  const { getAllModelsStatus } = useApi()

  const ioRowRef = useRef<HTMLDivElement>(null)
  const [handleTop, setHandleTop] = useState('50%')
  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
  }, [])

  const modelId     = (data.params.modelId as string | undefined) ?? ''
  const modelParams = (data.params.modelParams as Record<string, unknown>) ?? {}

  const patchParams = useCallback((patch: Record<string, unknown>) => {
    updateNodeData(id, { params: { ...data.params, ...patch } })
  }, [id, data.params, updateNodeData])

  // ── Model list ──────────────────────────────────────────────────────────────
  const [models, setModels] = useState<ServerModel[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  useEffect(() => {
    if (!apiUrl) return
    let cancelled = false
    setModelsLoaded(false)
    getAllModelsStatus()
      .then((list) => { if (!cancelled) { setModels(list); setModelsLoaded(true) } })
      .catch(() => { if (!cancelled) setModelsLoaded(true) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl])

  useEffect(() => {
    if (!modelId && models.length > 0) patchParams({ modelId: models[0].id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  // ── Per-model param schema ───────────────────────────────────────────────────
  const [schema, setSchema] = useState<ParamSchema[]>([])
  useEffect(() => {
    if (!apiUrl || !modelId) { setSchema([]); return }
    let cancelled = false
    fetch(`${apiUrl}/model/params?model_id=${encodeURIComponent(modelId)}`)
      .then((res) => res.json())
      .then((params: ParamSchema[]) => { if (!cancelled) setSchema(params) })
      .catch(() => { if (!cancelled) setSchema([]) })
    return () => { cancelled = true }
  }, [apiUrl, modelId])

  const selectedModel = models.find((m) => m.id === modelId)

  return (
    <BaseNode
      id={id}
      selected={selected}
      running={running}
      title="Server"
      enabled={data.enabled}
      showInGenerate={data.showInGenerate ?? false}
      collapsible
      minWidth={220}
      icon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2">
          <rect x="2" y="3" width="20" height="7" rx="1.5"/>
          <rect x="2" y="14" width="20" height="7" rx="1.5"/>
          <circle cx="6.5" cy="6.5" r="0.8" fill="#a78bfa" stroke="none"/>
          <circle cx="6.5" cy="17.5" r="0.8" fill="#a78bfa" stroke="none"/>
        </svg>
      }
      subheader={
        <div ref={ioRowRef} className="flex items-center justify-between px-3 py-2">
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS.image}`}>image</span>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS.mesh}`}>mesh</span>
        </div>
      }
      handles={
        <>
          <Handle
            id="input-0"
            type="target"
            position={Position.Left}
            style={{ background: HANDLE_COLOR.image, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
          />
          <Handle
            id="output"
            type="source"
            position={Position.Right}
            style={{ background: HANDLE_COLOR.mesh, width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
          />
        </>
      }
    >
      <div className="px-3 pb-3 pt-2.5 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">Server</label>
          <div
            className="flex-1 truncate text-[11px] text-zinc-400 px-2 py-1 rounded-lg bg-zinc-800/60 border border-zinc-800"
            title={apiUrl || undefined}
          >
            {apiUrl || '—'}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">Model</label>
          <select
            value={modelId}
            onChange={(e) => patchParams({ modelId: e.target.value, modelParams: {} })}
            className={`${inputCls} flex-1`}
          >
            {!modelsLoaded && <option value="">Loading…</option>}
            {modelsLoaded && models.length === 0 && <option value="">No models found on server</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}{m.downloaded ? '' : ' (downloads on run)'}
              </option>
            ))}
          </select>
        </div>

        {modelsLoaded && models.length === 0 && (
          <p className="text-[9px] text-zinc-600 leading-snug">
            No models found on the server. Install an extension on the server's EXTENSIONS_DIR, then reopen this node.
          </p>
        )}

        {selectedModel && !selectedModel.downloaded && (
          <p className="text-[9px] text-zinc-600 leading-snug">
            Not downloaded yet — the server will fetch it automatically the first time this node runs.
          </p>
        )}

        {schema.map((param) => {
          const val = (modelParams[param.id] ?? param.default) as number | string
          return (
            <div key={param.id} className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-500 w-24 shrink-0 leading-tight">{param.label}</label>
              <div className="flex-1">
                {param.type === 'select' ? (
                  <select
                    value={val}
                    onChange={(e) => patchParams({ modelParams: { ...modelParams, [param.id]: e.target.value } })}
                    className={inputCls}
                  >
                    {param.options?.map((o) => (
                      <option key={String(o.value)} value={o.value}>{o.label ?? String(o.value)}</option>
                    ))}
                  </select>
                ) : param.type === 'float' ? (
                  <FloatInput value={val as number} onChange={(v) => patchParams({ modelParams: { ...modelParams, [param.id]: v } })} />
                ) : param.type === 'int' ? (
                  <IntInput value={val as number} onChange={(v) => patchParams({ modelParams: { ...modelParams, [param.id]: v } })} />
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </BaseNode>
  )
}
