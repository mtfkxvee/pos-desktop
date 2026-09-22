<template>
	<div class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
		<div class="relative w-full max-w-lg bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]" @click.stop>
			<div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 bg-white">
				<h2 class="text-xl font-bold text-gray-900">{{ __('Printer Settings') }}</h2>
				<button @click="$emit('close')" class="p-2 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors">
					<XMarkIcon class="w-6 h-6" />
				</button>
			</div>

			<!-- Local-only settings — no network/internet dependency, so the form
			     itself always renders immediately. Only the Windows printer list
			     (loadingPrinters, a PowerShell call) gets its own small inline
			     loading state below, not the whole dialog. -->
			<div class="flex-1 overflow-y-auto p-6 space-y-5">
				<!-- Connection type -->
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-2">{{ __('Jenis Koneksi Printer') }}</label>
					<div class="flex gap-2">
						<button
							@click="mode = 'usb'"
							:class="['flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
								mode === 'usb' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50']"
						>
							{{ __('USB / Windows Printer') }}
						</button>
						<button
							@click="mode = 'network'"
							:class="['flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
								mode === 'network' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50']"
						>
							{{ __('Network / WiFi') }}
						</button>
						<button
							@click="mode = 'bluetooth'"
							:class="['flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
								mode === 'bluetooth' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50']"
						>
							{{ __('Bluetooth') }}
						</button>
					</div>
				</div>

				<!-- USB / Windows printer picker -->
				<div v-if="mode === 'usb'">
					<label class="block text-sm font-medium text-gray-700 mb-2">{{ __('Pilih Printer') }}</label>
					<select v-model="selectedWindowsPrinter" :disabled="loadingPrinters" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400">
						<option value="" disabled>
							{{ loadingPrinters ? __('Memuat daftar printer...') : __('-- Pilih printer terdaftar di Windows --') }}
						</option>
						<option v-for="p in windowsPrinters" :key="p.name" :value="p.name">
							{{ p.name }} ({{ p.port }})
						</option>
					</select>
					<button @click="loadWindowsPrinters" class="mt-2 text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
						<span v-if="loadingPrinters" class="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></span>
						{{ __('Muat ulang daftar printer') }}
					</button>
					<p v-if="!windowsPrinters.length && !loadingPrinters" class="mt-2 text-xs text-amber-600">
						{{ __('Tidak ada printer terdaftar di Windows. Colok printer & install driver-nya dulu (kebanyakan printer thermal USB otomatis muncul di sini setelah driver-nya di-install).') }}
					</p>
				</div>

				<!-- Network printer -->
				<div v-else-if="mode === 'network'">
					<label class="block text-sm font-medium text-gray-700 mb-2">{{ __('IP Printer') }}</label>
					<div class="flex gap-2">
						<input v-model="networkIp" type="text" placeholder="192.168.1.50" class="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
						<input v-model="networkPort" type="text" placeholder="9100" class="w-24 border border-gray-200 rounded-lg px-3 py-2 text-sm" />
					</div>
					<p class="mt-1 text-xs text-gray-500">{{ __('Port default ESC/POS network printer adalah 9100.') }}</p>
				</div>

				<!-- Bluetooth (COM/Serial) printer -->
				<div v-else>
					<label class="block text-sm font-medium text-gray-700 mb-2">{{ __('Pilih Port Bluetooth') }}</label>
					<select v-model="selectedComPort" :disabled="loadingComPorts" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400">
						<option value="" disabled>
							{{ loadingComPorts ? __('Memuat daftar port...') : __('-- Pilih COM port --') }}
						</option>
						<option v-for="p in comPorts" :key="p.port" :value="p.port">
							{{ p.label }}
						</option>
					</select>
					<button @click="loadComPorts" class="mt-2 text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
						<span v-if="loadingComPorts" class="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></span>
						{{ __('Muat ulang daftar port') }}
					</button>
					<p v-if="!comPorts.length && !loadingComPorts" class="mt-2 text-xs text-amber-600">
						{{ __('Belum ada printer Bluetooth ter-pair. Pair printer dulu lewat Windows Settings > Bluetooth & devices, baru muat ulang di sini.') }}
					</p>
					<label class="block text-sm font-medium text-gray-700 mt-3 mb-2">{{ __('Baud Rate') }}</label>
					<input v-model="baudRate" type="text" placeholder="9600" class="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
					<p class="mt-1 text-xs text-gray-500">{{ __('9600 cocok untuk hampir semua printer thermal Bluetooth. Cek manual printer kalau test print gagal/hasilnya acak.') }}</p>
				</div>

				<!-- Paper size -->
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-2">{{ __('Ukuran Kertas') }}</label>
					<div class="flex gap-2">
						<button
							@click="paperSize = '58mm'"
							:class="['flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
								paperSize === '58mm' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50']"
						>58mm</button>
						<button
							@click="paperSize = '80mm'"
							:class="['flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors',
								paperSize === '80mm' ? 'bg-blue-50 border-blue-400 text-blue-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50']"
						>80mm</button>
					</div>
				</div>

				<div v-if="message" :class="['text-sm rounded-lg px-3 py-2', messageIsError ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700']">
					{{ message }}
				</div>
			</div>

			<div class="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50">
				<Button variant="outline" :loading="testing" @click="testPrint">{{ __('Test Print') }}</Button>
				<Button variant="solid" theme="blue" :loading="saving" @click="save">{{ __('Simpan') }}</Button>
			</div>
		</div>
	</div>
</template>

<script setup>
import { ref, onMounted, computed } from "vue"
import { XMarkIcon } from "@heroicons/vue/24/outline"
import { Button } from "frappe-ui"
import { __ } from "@/utils/translation"

const emit = defineEmits(["close"])

const BASE = "http://127.0.0.1:8871"

const loadingPrinters = ref(false)
const saving = ref(false)
const testing = ref(false)
const message = ref("")
const messageIsError = ref(false)

const mode = ref("usb")
const windowsPrinters = ref([])
const selectedWindowsPrinter = ref("")
const networkIp = ref("")
const networkPort = ref("9100")
const comPorts = ref([])
const loadingComPorts = ref(false)
const selectedComPort = ref("")
const baudRate = ref("9600")
const paperSize = ref("58mm")

function parseInterface(printerInterface) {
	if (!printerInterface || printerInterface === "printer:auto") return
	const tcpMatch = /^tcp:\/\/([^:/]+)(?::(\d+))?/i.exec(printerInterface)
	if (tcpMatch) {
		mode.value = "network"
		networkIp.value = tcpMatch[1]
		networkPort.value = tcpMatch[2] || "9100"
		return
	}
	const comMatch = /^com:(.+)$/i.exec(printerInterface)
	if (comMatch) {
		mode.value = "bluetooth"
		selectedComPort.value = comMatch[1]
		return
	}
	const printerMatch = /^printer:(.+)$/i.exec(printerInterface)
	if (printerMatch) {
		mode.value = "usb"
		selectedWindowsPrinter.value = printerMatch[1]
	}
}

async function loadWindowsPrinters() {
	loadingPrinters.value = true
	try {
		const res = await fetch(`${BASE}/print/printers`)
		const data = await res.json()
		windowsPrinters.value = data.printers || []
	} catch (err) {
		message.value = __("Gagal memuat daftar printer: {0}", [err.message])
		messageIsError.value = true
	} finally {
		loadingPrinters.value = false
	}
}

async function loadComPorts() {
	loadingComPorts.value = true
	try {
		const res = await fetch(`${BASE}/print/com-ports`)
		const data = await res.json()
		comPorts.value = data.ports || []
	} catch (err) {
		message.value = __("Gagal memuat daftar port Bluetooth: {0}", [err.message])
		messageIsError.value = true
	} finally {
		loadingComPorts.value = false
	}
}

async function loadConfig() {
	try {
		const res = await fetch(`${BASE}/print/config`)
		const config = await res.json()
		parseInterface(config.printerInterface)
		paperSize.value = config.paperSize || "58mm"
		baudRate.value = String(config.baudRate || 9600)
	} catch (err) {
		message.value = __("Gagal memuat konfigurasi printer: {0}", [err.message])
		messageIsError.value = true
	}
}

const printerInterface = computed(() => {
	if (mode.value === "network") {
		return networkIp.value ? `tcp://${networkIp.value}:${networkPort.value || 9100}` : ""
	}
	if (mode.value === "bluetooth") {
		return selectedComPort.value ? `com:${selectedComPort.value}` : ""
	}
	return selectedWindowsPrinter.value ? `printer:${selectedWindowsPrinter.value}` : ""
})

async function save() {
	if (!printerInterface.value) {
		message.value = __("Pilih printer atau isi IP dulu.")
		messageIsError.value = true
		return
	}
	saving.value = true
	message.value = ""
	try {
		const res = await fetch(`${BASE}/print/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				printerInterface: printerInterface.value,
				paperSize: paperSize.value,
				baudRate: Number(baudRate.value) || 9600,
			}),
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || "Gagal menyimpan")
		message.value = __("Tersimpan.")
		messageIsError.value = false
	} catch (err) {
		message.value = err.message
		messageIsError.value = true
	} finally {
		saving.value = false
	}
}

async function testPrint() {
	if (!printerInterface.value) {
		message.value = __("Pilih printer atau isi IP dulu, lalu Simpan, sebelum Test Print.")
		messageIsError.value = true
		return
	}
	testing.value = true
	message.value = ""
	try {
		await save()
		const res = await fetch(`${BASE}/print/receipt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				invoice: {
					name: "TEST-PRINT",
					owner: "Test",
					customer_name: "Test Print",
					items: [{ item_name: "Contoh Barang", qty: 1, rate: 10000, amount: 10000 }],
					grand_total: 10000,
					payments: [{ mode_of_payment: "Cash", amount: 10000 }],
				},
				companyAddress: {},
			}),
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || "Test print gagal")
		message.value = __("Test print terkirim ke printer.")
		messageIsError.value = false
	} catch (err) {
		message.value = err.message
		messageIsError.value = true
	} finally {
		testing.value = false
	}
}

onMounted(() => {
	// Independent — run in parallel, neither blocks the form from rendering.
	loadConfig()
	loadWindowsPrinters()
	loadComPorts()
})
</script>
