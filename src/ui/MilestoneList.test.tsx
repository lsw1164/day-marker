import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MilestoneList } from '@/ui/MilestoneList'
import type { Row } from '@/ui/rows'

function row(over: Partial<Row> = {}): Row {
  return {
    key: 'd100',
    name: 'Day 100',
    date: 'Apr 9, 2026',
    badge: 'New',
    checked: true,
    selectable: true,
    muted: false,
    failed: false,
    ...over,
  }
}

describe('MilestoneList', () => {
  it('renders the heading and every row', () => {
    render(
      <MilestoneList
        heading="13 milestones · 11 selected"
        rows={[row(), row({ key: 'y1', name: '1 Year' })]}
        onToggle={() => {}}
      />,
    )
    expect(screen.getByText('13 milestones · 11 selected')).toBeInTheDocument()
    expect(screen.getByText('Day 100')).toBeInTheDocument()
    expect(screen.getByText('1 Year')).toBeInTheDocument()
  })

  it('reflects checked state', () => {
    render(
      <MilestoneList
        heading="h"
        rows={[row({ checked: true }), row({ key: 'd200', checked: false })]}
        onToggle={() => {}}
      />,
    )
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
  })

  it('disables checkboxes when the row is not selectable', () => {
    render(<MilestoneList heading="h" rows={[row({ selectable: false })]} onToggle={() => {}} />)
    expect(screen.getByRole('checkbox')).toBeDisabled()
  })

  it('calls onToggle with the row key', async () => {
    const onToggle = vi.fn()
    render(<MilestoneList heading="h" rows={[row()]} onToggle={onToggle} />)
    await userEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledWith('d100')
  })

  it('labels each checkbox with its milestone for screen readers', () => {
    render(<MilestoneList heading="h" rows={[row()]} onToggle={() => {}} />)
    expect(screen.getByRole('checkbox', { name: /Day 100/ })).toBeInTheDocument()
  })
})
