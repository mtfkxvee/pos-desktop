/**
 * Desktop build replacement for the old Dexie (IndexedDB) database.
 *
 * A handful of peripheral files (translationCache.js, backup.js,
 * OfflineInvoicesDialog.vue) still call `db.<table>.get/put/where/filter(...)`
 * directly. Rather than editing each one, this re-implements just enough of
 * Dexie's table API — backed by server/routes/db-generic.js (SQLite) — for
 * those call patterns to keep working. It fetches the whole table and
 * filters/sorts in memory, which is fine at POS data volumes (thousands of
 * rows, not millions).
 */
const BASE = "http://127.0.0.1:8871/db";

function makeTable(name) {
  async function all() {
    const res = await fetch(`${BASE}/${name}`);
    return res.ok ? res.json() : [];
  }

  return {
    async get(key) {
      if (typeof key === "object") {
        // Dexie compound-key style get({field: value}) — fall back to a
        // linear scan since the generic route only supports single PK gets.
        const rows = await all();
        return rows.find((r) => Object.entries(key).every(([k, v]) => r[k] === v)) || undefined;
      }
      const res = await fetch(`${BASE}/${name}/${encodeURIComponent(key)}`);
      if (!res.ok) return undefined;
      const data = await res.json();
      return data || undefined;
    },
    async put(obj) {
      const pk = obj.name ?? obj.item_code ?? obj.locale ?? obj.key ?? obj.id;
      await fetch(`${BASE}/${name}/${encodeURIComponent(pk)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(obj),
      });
      return pk;
    },
    async add(obj) {
      return this.put(obj);
    },
    async bulkPut(objs) {
      for (const obj of objs) await this.put(obj);
      return objs.length;
    },
    async delete(key) {
      await fetch(`${BASE}/${name}/${encodeURIComponent(key)}`, { method: "DELETE" });
    },
    async clear() {
      await fetch(`${BASE}/${name}`, { method: "DELETE" });
      return 0;
    },
    where(field) {
      return {
        equals: (value) => ({
          async toArray() {
            const rows = await all();
            return rows.filter((r) => r[field] === value);
          },
          async first() {
            const rows = await all();
            return rows.find((r) => r[field] === value);
          },
          async delete() {
            const rows = await all();
            const matches = rows.filter((r) => r[field] === value);
            for (const m of matches) {
              const pk = m.name ?? m.item_code ?? m.locale ?? m.key;
              await fetch(`${BASE}/${name}/${encodeURIComponent(pk)}`, { method: "DELETE" });
            }
            return matches.length;
          },
        }),
      };
    },
    filter(predicate) {
      const self = this;
      return {
        async toArray() {
          const rows = await all();
          return rows.filter(predicate);
        },
        async first() {
          const rows = await all();
          return rows.find(predicate);
        },
        async count() {
          const rows = await all();
          return rows.filter(predicate).length;
        },
        async delete() {
          const rows = await all();
          const matches = rows.filter(predicate);
          for (const m of matches) {
            const pk = m.name ?? m.item_code ?? m.locale ?? m.key;
            await fetch(`${BASE}/${name}/${encodeURIComponent(pk)}`, { method: "DELETE" });
          }
          return matches.length;
        },
        async modify(fn) {
          const rows = await all();
          const matches = rows.filter(predicate);
          for (const m of matches) {
            fn(m);
            await self.put(m);
          }
          return matches.length;
        },
      };
    },
    async toArray() {
      return all();
    },
  };
}

export const db = {
  items: makeTable("items"),
  customers: makeTable("customers"),
  offers: makeTable("offers"),
  invoice_history: makeTable("invoice_history"),
  unpaid_invoices: makeTable("unpaid_invoices"),
  drafts: makeTable("drafts"),
  translations: makeTable("translations"),
  // invoice_queue/customer_queue have a different shape (offline_id/status/
  // payload, not a flat document) — point them at the dedicated
  // /invoices/queue and /customers/queue endpoints. Only the read patterns
  // actually used (backup.js, OfflineInvoicesDialog.vue) are implemented;
  // this is a peripheral (backup/export) feature, not the core sale flow.
  invoice_queue: {
    async filter(predicate) {
      const res = await fetch("http://127.0.0.1:8871/invoices/queue");
      const rows = res.ok ? await res.json() : [];
      return {
        async first() {
          return rows.find(predicate);
        },
        async toArray() {
          return rows.filter(predicate);
        },
        async count() {
          return rows.filter(predicate).length;
        },
      };
    },
    async add(entry) {
      await fetch("http://127.0.0.1:8871/invoices/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice: entry.data, data: {} }),
      });
    },
  },
  customer_queue: {
    async filter(predicate) {
      const res = await fetch("http://127.0.0.1:8871/customers/queue");
      const rows = res.ok ? await res.json() : [];
      return {
        async first() {
          return rows.find(predicate);
        },
        async toArray() {
          return rows.filter(predicate);
        },
      };
    },
  },
  isOpen: () => true,
  close() {},
};

export const initDB = async () => true;
export const checkDBHealth = async () => true;

export const getSetting = async (key, defaultValue = null) => {
  try {
    const res = await fetch(`http://127.0.0.1:8871/settings/${encodeURIComponent(key)}`);
    if (!res.ok) return defaultValue;
    const data = await res.json();
    return data.value;
  } catch {
    return defaultValue;
  }
};

export const setSetting = async (key, value) => {
  try {
    await fetch(`http://127.0.0.1:8871/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  } catch {
    // best-effort, matches old db.js's swallow-and-log behavior
  }
};
