// Records Tauri invokes so host-side portal logic can be tested in Node.
export const calls = []
export let reply = () => JSON.stringify(JSON.stringify({ ok: true, result: {} }))
export function setReply(fn) { reply = fn }
export async function invoke(command, args) {
  calls.push({ command, args })
  return command === 'portal_eval' ? reply(args) : undefined
}
export async function listen() { return () => {} }
export const convertFileSrc = path => path
