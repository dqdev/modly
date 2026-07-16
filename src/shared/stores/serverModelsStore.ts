import { create } from 'zustand'
import axios from 'axios'
import { useAppStore } from './appStore'

export type IoType = 'image' | 'text' | 'mesh'

export interface ServerModelInfo {
  id:         string
  name:       string
  downloaded: boolean
  input:      IoType
  inputs?:    IoType[]
  output:     IoType
}

interface ServerModelsStore {
  models:       ServerModelInfo[]
  loaded:       boolean
  loadedForUrl: string | null
  load:         () => Promise<void>
}

// Shared across ServerNode instances, the workflow canvas's connection
// validation, and preflight — all need the same "which inputs does this
// server-registry model need" data without each re-fetching it.
export const useServerModelsStore = create<ServerModelsStore>((set) => ({
  models:       [],
  loaded:       false,
  loadedForUrl: null,

  async load() {
    const apiUrl = useAppStore.getState().apiUrl
    if (!apiUrl) { set({ models: [], loaded: true, loadedForUrl: null }); return }
    try {
      const { data } = await axios.get<ServerModelInfo[]>(`${apiUrl}/model/all`)
      set({ models: data, loaded: true, loadedForUrl: apiUrl })
    } catch {
      set({ models: [], loaded: true, loadedForUrl: apiUrl })
    }
  },
}))

export function getServerModelInfo(modelId: string): ServerModelInfo | undefined {
  return useServerModelsStore.getState().models.find((m) => m.id === modelId)
}
