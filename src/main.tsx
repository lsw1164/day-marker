import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAppCalendar } from '@/google/appCalendar'
import { createAppDataStore } from '@/google/appData'
import { createAuth } from '@/google/auth'
import { createCalendarApi, createCalendarsApi } from '@/google/calendarApi'
import { Root } from '@/ui/Root'
import './index.css'

const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const auth = createAuth(clientId)
const token = () => auth.token() ?? ''

/**
 * One calendar, found through the user's own Drive app-data folder. `api` reads
 * the ID lazily because nothing is known here: the calendar is only resolved
 * once the user connects.
 */
const calendar = createAppCalendar(createAppDataStore(token), createCalendarsApi(token))
const api = createCalendarApi(token, () => calendar.id())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root deps={{ auth, api, calendar }} />
  </StrictMode>,
)
