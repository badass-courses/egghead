export function LearningStreakBadge({ days }: { days: number }) {
	return (
		<p
			aria-label={`Current learning streak: ${days} ${days === 1 ? 'day' : 'days'}`}
			className={`inline-flex min-h-10 items-center rounded-full px-4 py-2 text-sm font-semibold tabular-nums ${
				days > 0
					? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
					: 'bg-muted text-muted-foreground'
			}`}
			title="Consecutive UTC days with a completed lesson or course"
		>
			{days}-day learning streak
		</p>
	)
}
