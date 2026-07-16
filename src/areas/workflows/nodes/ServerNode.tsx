import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Handle, Position, useReactFlow } from '@xyflow/react'
import { useAppStore } from '@shared/stores/appStore'
import { useServerModelsStore } from '@shared/stores/serverModelsStore'
import type { WFNodeData, ParamSchema } from '@shared/types/electron.d'
import { useWorkflowRunStore } from '../workflowRunStore'
import BaseNode from './BaseNode'

// ─── Handle colors ────────────────────────────────────────────────────────────

const HANDLE_COLOR: Record<string, string> = { image: '#38bdf8', mesh: '#a78bfa', text: '#facc15' }
const TAG_CLS: Record<string, string> = {
  image: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  mesh:  'border-violet-500/30 bg-violet-500/10 text-violet-400',
  text:  'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
}

const inputCls = 'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-200 focus:outline-none focus:border-accent/60'

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

  // Refs for handle alignment — support up to 2 inputs (mirrors ExtensionNode)
  const ioRowRef  = useRef<HTMLDivElement>(null)
  const ioRow2Ref = useRef<HTMLDivElement>(null)
  const [handleTop,  setHandleTop]  = useState('50%')
  const [handle2Top, setHandle2Top] = useState('50%')

  const modelId     = (data.params.modelId as string | undefined) ?? ''
  const modelParams = (data.params.modelParams as Record<string, unknown>) ?? {}

  const patchParams = useCallback((patch: Record<string, unknown>) => {
    updateNodeData(id, { params: { ...data.params, ...patch } })
  }, [id, data.params, updateNodeData])

  // ── Model list ──────────────────────────────────────────────────────────────
  // Shared store: the model list (with per-model input/output schema) is fetched
  // once and reused by connection validation + preflight, not just this node.
  const models      = useServerModelsStore((s) => s.models)
  const loadModels  = useServerModelsStore((s) => s.load)
  const [modelsLoaded, setModelsLoaded] = useState(false)
  useEffect(() => {
    if (!apiUrl) return
    setModelsLoaded(false)
    loadModels().finally(() => setModelsLoaded(true))
  }, [apiUrl, loadModels])

  useEffect(() => {
    if (!modelId && models.length > 0) patchParams({ modelId: models[0].id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])

  const selectedModel = models.find((m) => m.id === modelId)
  const inputs        = selectedModel?.inputs   // defined → multi-input mode
  const isMulti        = !!inputs && inputs.length > 1
  const outputType     = selectedModel?.output ?? 'mesh'

  useLayoutEffect(() => {
    if (ioRowRef.current) {
      const center = ioRowRef.current.offsetTop + ioRowRef.current.offsetHeight / 2
      setHandleTop(`${center}px`)
    }
    if (ioRow2Ref.current) {
      const center = ioRow2Ref.current.offsetTop + ioRow2Ref.current.offsetHeight / 2
      setHandle2Top(`${center}px`)
    }
  }, [isMulti])

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
        isMulti ? (
          // Multi-input layout: one row per input, output on first row (mirrors ExtensionNode)
          <div className="flex flex-col divide-y divide-zinc-800/40">
            <div ref={ioRowRef} className="flex items-center justify-between px-3 py-2">
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[inputs[0]] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                {inputs[0]}
              </span>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
                <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
              </svg>
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[outputType] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                {outputType}
              </span>
            </div>
            <div ref={ioRow2Ref} className="flex items-center px-3 py-2">
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[inputs[1]] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
                {inputs[1]}
              </span>
            </div>
          </div>
        ) : (
          <div ref={ioRowRef} className="flex items-center justify-between px-3 py-2">
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[selectedModel?.input ?? 'image'] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
              {selectedModel?.input ?? 'image'}
            </span>
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600 shrink-0">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${TAG_CLS[outputType] ?? 'border-zinc-700 bg-zinc-800 text-zinc-400'}`}>
              {outputType}
            </span>
          </div>
        )
      }
      handles={
        <>
          <Handle
            id="input-0"
            type="target"
            position={Position.Left}
            style={{ background: HANDLE_COLOR[isMulti ? inputs[0] : (selectedModel?.input ?? 'image')], width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
          />
          {isMulti && (
            <Handle
              id="input-1"
              type="target"
              position={Position.Left}
              style={{ background: HANDLE_COLOR[inputs[1]], width: 14, height: 14, border: '2.5px solid #18181b', top: handle2Top }}
            />
          )}
          <Handle
            id="output"
            type="source"
            position={Position.Right}
            style={{ background: HANDLE_COLOR[outputType], width: 14, height: 14, border: '2.5px solid #18181b', top: handleTop }}
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
