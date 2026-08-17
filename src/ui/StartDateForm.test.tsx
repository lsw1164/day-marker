import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StartDateForm } from '@/ui/StartDateForm'

const base = {
  startDate: '2026-01-01',
  label: '',
  years: 3,
  reminder: 'day1' as const,
  onStartDate: () => {},
  onLabel: () => {},
  onYears: () => {},
  onReminder: () => {},
  disabled: false,
}

describe('StartDateForm', () => {
  it('renders the current values', () => {
    render(<StartDateForm {...base} />)
    expect(screen.getByLabelText(/Start date/)).toHaveValue('2026-01-01')
    expect(screen.getByLabelText(/Range/)).toHaveValue('3')
    expect(screen.getByLabelText(/Reminder/)).toHaveValue('day1')
  })

  it('emits the raw date string', () => {
    const onStartDate = vi.fn()
    render(<StartDateForm {...base} startDate="" onStartDate={onStartDate} />)
    // userEvent.type is unreliable on <input type="date">; set the value directly.
    fireEvent.change(screen.getByLabelText(/Start date/), { target: { value: '2026-03-14' } })
    expect(onStartDate).toHaveBeenCalledWith('2026-03-14')
  })

  it('emits the range as a number', async () => {
    const onYears = vi.fn()
    render(<StartDateForm {...base} onYears={onYears} />)
    await userEvent.selectOptions(screen.getByLabelText(/Range/), '5')
    expect(onYears).toHaveBeenCalledWith(5)
  })

  it('emits the reminder preset', async () => {
    const onReminder = vi.fn()
    render(<StartDateForm {...base} onReminder={onReminder} />)
    await userEvent.selectOptions(screen.getByLabelText(/Reminder/), 'week1')
    expect(onReminder).toHaveBeenCalledWith('week1')
  })

  it('offers exactly the four allowed reminder presets', () => {
    render(<StartDateForm {...base} />)
    const options = screen.getByLabelText(/Reminder/).querySelectorAll('option')
    expect(Array.from(options).map((o) => o.value)).toEqual(['none', 'day1', 'day3', 'week1'])
  })

  it('disables every control when disabled', () => {
    render(<StartDateForm {...base} disabled />)
    expect(screen.getByLabelText(/Start date/)).toBeDisabled()
    expect(screen.getByLabelText(/Range/)).toBeDisabled()
  })
})
