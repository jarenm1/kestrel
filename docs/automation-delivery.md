# Automation trigger delivery

Scheduled and GitHub triggers are stored as jobs in the Hub before dispatch. A schedule's advance and its job, or a webhook's delivery ID and all its matching jobs, commit together. Jobs contain the automation settings at acceptance time and remain queued if the automation is later edited or deleted. The alarm recovers queued jobs after the Hub restarts.

Delivery is at least once only for interruptions before a dispatch attempt finishes. The box does not accept an idempotency key for task creation or messages: if it accepts a request but the Hub stops before recording completion, a retry can create another task or send another message. A completed box response reporting an error is recorded as a failed run and is not automatically retried; a lost response is ambiguous. Manual runs do not use this queue. Webhook delivery IDs are retained for a limited period, so an older redelivery can create another job.

If a schedule is overdue, the alarm creates one job and advances to the first occurrence after the alarm's current time. Multiple missed occurrences therefore coalesce; they are not replayed individually. Editing the name, prompt or model preserves the existing due time. Changing the trigger or enabled state recalculates it.
