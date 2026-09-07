export function businessDate(value: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(value)
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}
