import { useCallback, useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

export const THEME_KEY = 'dayMarker.theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function nextChoice(choice: ThemeChoice): ThemeChoice {
  return choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system'
}

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'dark' || value === 'light' ? value : 'system'
  } catch {
    // Private browsing can throw. Following the OS is the right fallback.
    return 'system'
  }
}

export function useTheme(): {
  choice: ThemeChoice
  setChoice: (choice: ThemeChoice) => void
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored)

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY)
    const apply = () => {
      const dark = choice === 'dark' || (choice === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    // Only subscribe while the OS is actually deciding. Once the choice is
    // explicit, an OS flip is none of our business.
    if (choice !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [choice])

  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      // Removed rather than stored as "system", so a fresh browser and a browser
      // reset to system behave identically.
      if (next === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, next)
    } catch {
      // The preference will not persist; the session still honours it.
    }
    setChoiceState(next)
  }, [])

  return { choice, setChoice }
}
