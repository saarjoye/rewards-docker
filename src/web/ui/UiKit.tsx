import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react'
import { Alert } from 'tdesign-react/es/alert/index.js'
import { Button as TButton } from 'tdesign-react/es/button/index.js'
import { Empty } from 'tdesign-react/es/empty/index.js'
import { Input } from 'tdesign-react/es/input/index.js'
import { Select } from 'tdesign-react/es/select/index.js'
import { Table } from 'tdesign-react/es/table/index.js'
import { Tag } from 'tdesign-react/es/tag/index.js'
import type { ButtonProps, InputRef } from 'tdesign-react'
import { stateLabel, publicText } from './display'

// Preserve native disabled semantics; the library otherwise renders a disabled div.
export function Button(props: ButtonProps): ReactElement {
  return <TButton {...props} tag="button" />
}
export function StatusTag({ value, label }: { value: string; label?: string }): ReactElement {
  const theme = ['completed', 'confirmed', 'final', 'success', 'sent', 'accepted'].includes(value)
    ? 'success'
    : ['failed', 'conflict', 'interrupted'].includes(value)
      ? 'danger'
      : [
            'partial',
            'pending',
            'unmatched',
            'overreported',
            'provisional',
            'verification-pending',
            'action-required'
          ].includes(value)
        ? 'warning'
        : ['running', 'live', 'sending'].includes(value)
          ? 'primary'
          : 'default'
  return (
    <Tag theme={theme} variant="light-outline">
      {label ?? stateLabel(value)}
    </Tag>
  )
}
export function Feedback({ error, message }: { error?: string; message?: string }): ReactElement {
  return (
    <>
      {error && (
        <div role="alert">
          <Alert theme="error" message={publicText(error)} />
        </div>
      )}
      {message && (
        <div role="status">
          <Alert theme="success" message={publicText(message)} />
        </div>
      )}
    </>
  )
}
export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: string
  actions?: ReactNode
}): ReactElement {
  return (
    <div className="page-heading">
      <div>
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  )
}
export function Field({
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  disabled = false,
  placeholder = '',
  maxLength,
  autoComplete = 'off',
  hint
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password' | 'email'
  required?: boolean
  disabled?: boolean
  placeholder?: string
  maxLength?: number
  autoComplete?: string
  hint?: string | undefined
}): ReactElement {
  const id = useId()
  const input = useRef<InputRef>(null)
  useEffect(() => {
    // TDesign exposes its input element, but not native required/id/email props.
    const element = input.current?.inputElement
    if (!element) return
    element.id = id
    element.required = required
    element.setAttribute('aria-label', label)
    if (type === 'email') element.type = 'email'
  }, [id, label, required, type])
  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required && <span className="required-mark"> *</span>}
      </label>
      <Input
        ref={input}
        value={value}
        onChange={onChange}
        type={type === 'email' ? 'text' : type}
        disabled={disabled}
        placeholder={placeholder}
        {...(maxLength === undefined ? {} : { maxlength: maxLength })}
        autocomplete={autoComplete}
      />
      {hint && <small className="muted">{hint}</small>}
    </div>
  )
}
export function SelectField({
  label,
  value,
  onChange,
  options,
  disabled = false
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ label: string; value: string }>
  disabled?: boolean
}): ReactElement {
  const id = useId()
  return (
    <label className="form-field">
      <span id={id}>{label}</span>
      <Select
        value={value}
        options={options}
        disabled={disabled}
        onChange={(v) => {
          if (typeof v === 'string' || typeof v === 'number') onChange(String(v))
        }}
        aria-labelledby={id}
      />
    </label>
  )
}
export interface DataColumn<T> {
  key: string
  title: string
  cell: (row: T) => ReactNode
}
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  empty = '暂无记录',
  loading = false
}: {
  rows: T[]
  columns: DataColumn<T>[]
  rowKey: (row: T) => string
  empty?: string
  loading?: boolean
}): ReactElement {
  return (
    <div className="responsive-data">
      <div className="desktop-data task-table-wrap">
        <Table
          rowKey="key"
          data={rows.map((value) => ({ key: rowKey(value), value }))}
          loading={loading}
          hover
          size="medium"
          empty={empty}
          columns={columns.map((column) => ({
            colKey: column.key,
            title: column.title,
            cell: ({ row }: { row: { key: string; value: T } }) => column.cell(row.value)
          }))}
        />
      </div>
      <div className="mobile-data">
        {rows.length === 0 ? (
          <Empty description={loading ? '读取中' : empty} />
        ) : (
          rows.map((row) => (
            <article className="mobile-record" key={rowKey(row)}>
              <dl>
                {columns.map((column) => (
                  <div key={column.key}>
                    <dt>{column.title}</dt>
                    <dd>{column.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))
        )}
      </div>
    </div>
  )
}
