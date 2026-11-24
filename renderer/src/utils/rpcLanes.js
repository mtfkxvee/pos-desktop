/**
 * Which local-server port an /rpc call goes to.
 *
 * Chromium opens at most 6 connections per host:port. /rpc methods the local
 * server proxies to the ERP hold their connection for as long as the ERP
 * takes; on a slow server a few of them filled all 6 and the cashier's
 * purely local calls (item search, barcode lookup, checkout queue) waited
 * behind them. So proxied methods go to a separate "live" port and only
 * compete with each other — the cashier's local work keeps its own lane.
 *
 * The list of locally-answered methods comes from the server itself
 * (GET /rpc/_lanes) so it can never drift from server/routes/rpc.js. Until
 * it has loaded — or if the live port isn't available — everything uses the
 * main port, i.e. the previous behaviour.
 */

const LOCAL_SERVER_BASE = "http://127.0.0.1:8871"

let localMethods = null
let liveBase = null
let loading = null

function loadLanes() {
	if (loading) return
	loading = fetch(`${LOCAL_SERVER_BASE}/rpc/_lanes`, { cache: "no-store" })
		.then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
		.then((data) => {
			localMethods = new Set(data.localMethods || [])
			liveBase = data.livePort ? `http://127.0.0.1:${data.livePort}` : null
		})
		.catch(() => {
			// Server not up yet — try again on the next call
			loading = null
		})
}

export function rpcUrl(method) {
	if (!localMethods) loadLanes()
	const live = localMethods && liveBase && !localMethods.has(method)
	return `${live ? liveBase : LOCAL_SERVER_BASE}/rpc/${method}`
}

if (typeof window !== "undefined") loadLanes()
