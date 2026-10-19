export const READY_PHOTOS_BASE_SQL = `SELECT p.* FROM photos p
  WHERE p.approved=true AND NOT EXISTS
    (SELECT 1 FROM editions e WHERE e.photo_id=p.id AND e.status<>'cancelled')
  ORDER BY p.created_at ASC,p.id ASC`;
export const READY_PHOTO_SQL = `${READY_PHOTOS_BASE_SQL} LIMIT 1`;
