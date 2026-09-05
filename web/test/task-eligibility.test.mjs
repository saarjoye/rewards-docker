import assert from 'node:assert/strict'
import test from 'node:test'
import { currentTasks, normalizedTasks } from '../src/task-view.mjs'

test('only explicitly excluded unexecuted tasks disappear from current tasks; history remains intact', () => {
    const tasks = [
        { id: 'unsupported', status: 'pending', eligibility: 'excluded' },
        { id: 'locked', status: 'locked', eligibility: 'excluded' },
        { id: 'disabled', status: 'pending', eligibility: 'excluded' },
        { id: 'unknown', status: 'pending', eligibility: 'unknown' },
        { id: 'failed', status: 'failed', eligibility: 'excluded' },
        { id: 'pending-credit', status: 'verifying', eligibility: 'excluded' },
        { id: 'executed', status: 'completed', eligibility: 'excluded', invocationId: 'synthetic' },
        { id: 'zero', expectedPoints: 0, status: 'completed' },
        { id: 'legacy', status: 'locked' }
    ]
    const original = structuredClone(tasks)
    assert.deepEqual(
        currentTasks(tasks).map(task => task.id),
        ['unknown', 'failed', 'pending-credit', 'executed', 'zero', 'legacy']
    )
    assert.equal(normalizedTasks(tasks).length, tasks.length)
    assert.deepEqual(tasks, original)
})

test('missing or unread task lists are not manufactured into hidden tasks', () => {
    assert.deepEqual(currentTasks(undefined), [])
    const unknown = { title: '任务数据缺失', expectedPoints: null, status: 'pending' }
    assert.equal(currentTasks([unknown]).length, 1)
    assert.equal(normalizedTasks(currentTasks([unknown]))[0].expectedPoints, null)
})
