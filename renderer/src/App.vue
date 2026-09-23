<template>
  <div>
    <!-- Quick readiness check still in flight (normally well under a
         second): a real spinner here, not an empty template — an empty
         template left the window showing a blank white flash right after
         login while this check was still running. -->
    <div v-if="gateState === 'checking'" class="fixed inset-0 flex items-center justify-center bg-gray-50">
      <div class="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
    </div>
    <InitialSync v-else-if="gateState === 'syncing'" @ready="gateState = 'ready'" />
    <router-view v-else :key="translationVersion" />
    <Toast />
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue"
import Toast from "@/components/common/Toast.vue"
import InitialSync from "@/pages/InitialSync.vue"
import { fetchSyncOverview, isFullyReady } from "@/composables/useInitialSync"
import { translationVersion } from "@/utils/translation"
import { logger } from "@/utils/logger"

const log = logger.create("App")

// "checking" | "syncing" | "ready". Starts at "checking" so the common case
// (data already downloaded from an earlier login) never flashes the
// InitialSync screen — only a login on a genuinely fresh device, or one
// where a previous sync attempt never completed, falls through to it.
const gateState = ref("checking")

onMounted(async () => {
  try {
    const overview = await fetchSyncOverview()
    gateState.value = isFullyReady(overview) ? "ready" : "syncing"
  } catch (err) {
    // Local server not answering yet (rare startup race) — fail toward
    // "syncing" rather than silently dropping the cashier into a POSSale
    // that has nothing to show, since InitialSync retries on its own.
    log.warn("Initial readiness check failed, falling back to sync screen", err)
    gateState.value = "syncing"
  }
})
</script>
