import { NavLink } from 'react-router-dom'
import { Monitor, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { COPY } from '@/ui/copy'
import { nextChoice, useTheme, type ThemeChoice } from '@/ui/useTheme'

const TAB =
  'flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium'

const ICON: Record<ThemeChoice, typeof Monitor> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

export function Header() {
  return (
    <header className="mx-auto w-full max-w-md px-4 pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{COPY.appName}</h1>
          <p className="text-xs text-muted-foreground">{COPY.tagline}</p>
        </div>
        <ThemeToggle />
      </div>
      {/*
        A segmented control rather than a bottom tab bar: the write flow ends in a
        sticky primary button, so a second bottom bar would consume roughly 120px
        of a small screen and push that button away from the thumb.
      */}
      <nav aria-label={COPY.navLabel} className="mt-3 flex gap-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            cn(
              TAB,
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )
          }
        >
          {COPY.navNew}
        </NavLink>
        <NavLink
          to="/registrations"
          className={({ isActive }) =>
            cn(
              TAB,
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )
          }
        >
          {COPY.navRegistrations}
        </NavLink>
      </nav>
    </header>
  )
}

function ThemeToggle() {
  const { choice, setChoice } = useTheme()
  const Icon = ICON[choice]
  const next = nextChoice(choice)
  const name = `${COPY.themeLabel(choice)}. ${COPY.themeAction(next)}`
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11"
      aria-label={name}
      title={name}
      onClick={() => setChoice(next)}
    >
      <Icon aria-hidden="true" />
    </Button>
  )
}
