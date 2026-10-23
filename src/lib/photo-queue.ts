export const READY_PHOTOS_BASE_SQL = `SELECT p.*,q.last_sent_day FROM photos p
  JOIN photo_queue q ON q.photo_id=p.id
  ORDER BY p.queue_pinned_at DESC NULLS LAST,q.last_sent_day ASC NULLS FIRST,p.created_at ASC,p.id ASC`;
export const READY_PHOTO_SQL = `${READY_PHOTOS_BASE_SQL} LIMIT 1`;
