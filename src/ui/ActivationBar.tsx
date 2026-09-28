import { useStore, selectActive } from '../store/workspace'
import type { WidgetElement } from '../lib/types'

// Opening a `.ccnvs` is not consent to run the agents it describes. This bar
// summarizes launch-relevant settings before one explicit activation.
export function ActivationBar() {
  const ws = useStore(selectActive)
  const activateWorkspace = useStore((s) => s.activateWorkspace)
  if (!ws.activationRequired) return null
  const agents = ws.elements.filter(
    (element): element is WidgetElement => element.type === 'widget' && element.kind === 'agent',
  )
  const pi = agents.filter((agent) => agent.harness === 'pi').length
  const claude = agents.length - pi
  const bypass = agents.filter((agent) => agent.harness !== 'pi' && agent.skipPermissions).length
  return (
    <div className="activation-bar" role="alert">
      <span>
        Opened canvas: <b>{agents.length}</b> agent{agents.length === 1 ? '' : 's'} paused
        {' '}({pi} Pi · {claude} Claude)
      </span>
      {bypass > 0 && (
        <span className="activation-bar__danger">
          {bypass} request{bypass === 1 ? 's' : ''} Claude permission bypass
        </span>
      )}
      <button className="activation-bar__btn" onClick={() => activateWorkspace(ws.id)}>
        Activate agents
      </button>
    </div>
  )
}
