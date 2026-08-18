import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Header } from '@/ui/Header'
import { COPY } from '@/ui/copy'

function renderAt(path: string) {
  // NavLink needs a router in context; MemoryRouter also lets us assert which
  // link is current without touching real history.
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>,
  )
}

describe('Header', () => {
  it('shows the app identity', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: COPY.appName })).toBeInTheDocument()
    expect(screen.getByText(COPY.tagline)).toBeInTheDocument()
  })

  it('links to both sections', () => {
    renderAt('/')
    expect(screen.getByRole('link', { name: COPY.navNew })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: COPY.navRegistrations })).toHaveAttribute(
      'href',
      '/registrations',
    )
  })

  it('marks the current section for assistive tech, not by colour alone', () => {
    renderAt('/registrations')
    expect(screen.getByRole('link', { name: COPY.navRegistrations })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: COPY.navNew })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('names the navigation region', () => {
    renderAt('/')
    expect(screen.getByRole('navigation', { name: COPY.navLabel })).toBeInTheDocument()
  })
})
