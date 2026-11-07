import type { JSX, ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import './controls.css'

export interface EmptyStateProps {
  icon?: IconName
  title: string
  description?: ReactNode
  /** Usually a button. */
  action?: ReactNode
  className?: string
}

/** Centered placeholder for an empty panel or tab. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={`ui-empty${className ? ` ${className}` : ''}`}>
      {icon ? (
        <div className="ui-empty-icon">
          <Icon name={icon} size={28} />
        </div>
      ) : null}
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  )
}
