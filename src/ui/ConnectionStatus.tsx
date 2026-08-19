import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { COPY } from '@/ui/copy'

export interface ConnectionStatusProps {
  connected: boolean
  /**
   * Whether signing out is offered at this moment. Each page decides for itself,
   * because each has a different run to protect: clearing the token mid-write or
   * mid-delete fails everything still queued, and the user would read a report
   * full of errors they did not cause.
   */
  canSignOut: boolean
  onSignOut: () => void
}

/**
 * Shared by both routes rather than lifted into the Header, which would look
 * like the natural home. `connected` is state inside each page's own hook, with
 * no subscription to the auth singleton, so a control in the Header could clear
 * the token without either page hearing about it. Only one route is mounted at a
 * time, so carrying this per page costs nothing.
 */
export function ConnectionStatus({ connected, canSignOut, onSignOut }: ConnectionStatusProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {/*
          Redundant with the word beside it, never a substitute: state carried by
          colour alone is lost on anyone who cannot separate the two hues. It
          earns its place by being pre-attentive -- you see the state before you
          read it. aria-hidden for the same reason: the text already says this.
        */}
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 rounded-full',
            connected ? 'bg-primary' : 'bg-muted-foreground/40',
          )}
        />
        {connected ? COPY.connected : COPY.notConnected}
      </span>
      {connected && canSignOut && (
        <Button
          variant="ghost"
          /*
            min-h-11 for the 44px floor: `size="sm"` is h-7, which is 28px.

            And styled to read as a control. At `text-xs text-muted-foreground`
            this was pixel-identical to the status label beside it, so the only
            actionable half of the cluster looked like more static text -- the
            underline on hover and full-strength colour say "you can press this"
            without giving a secondary action the weight of a filled button.
          */
          className="min-h-11 px-2 text-sm text-foreground underline-offset-4 hover:underline"
          onClick={onSignOut}
        >
          {COPY.signOut}
        </Button>
      )}
    </div>
  )
}
