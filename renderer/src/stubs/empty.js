// Dev-server-only stub — see vite.config.js. frappe-ui's barrel (src/index.ts)
// unconditionally re-exports its TextEditor component, which this POS app
// never uses, but which drags in a chain of CJS deps (feather-icons,
// highlight.js, prosemirror/tiptap, ...) that broke Vite's dev-server
// prebundling one at a time as each was reached. Production `vite build`
// tree-shakes the unused re-export away automatically (Rollup), so this
// stub is only wired in for `vite`/dev mode.
export default {}
