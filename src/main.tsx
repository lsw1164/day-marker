import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAuth } from '@/google/auth'
import { createCalendarApi } from '@/google/calendarApi'
import { App } from '@/ui/App'
import './index.css'

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const auth = createAuth(clientId)
const api = createCalendarApi(() => auth.token() ?? '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App deps={{ auth, api }} />
  </StrictMode>,
)
