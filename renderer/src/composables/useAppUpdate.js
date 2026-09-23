/**
 * Bridges main/index.js's electron-updater events (via main/preload.js) into
 * reactive state for AppUpdateBanner.vue. Module-level state — shared by
 * every component that calls this, and the IPC listener is only ever
 * registered once, since the 'update-ready' event can fire at any time
 * (whenever a background download finishes) independent of which
 * component instance is currently mounted.
 *
 * `window.posDesktop` only exists in the packaged/Electron-loaded renderer
 * (it's set by preload.js's contextBridge) — guarded so this is a no-op
 * during `vite dev` outside Electron and never throws.
 */
import { ref } from "vue"

const updateReady = ref(false)
const updateVersion = ref(null)
let listenerAttached = false

function attachListener() {
	if (listenerAttached || !window.posDesktop?.onUpdateReady) return
	listenerAttached = true
	window.posDesktop.onUpdateReady((info) => {
		updateVersion.value = info?.version || null
		updateReady.value = true
	})
}

export function useAppUpdate() {
	attachListener()

	function installNow() {
		window.posDesktop?.installUpdateNow?.()
	}

	return { updateReady, updateVersion, installNow }
}
