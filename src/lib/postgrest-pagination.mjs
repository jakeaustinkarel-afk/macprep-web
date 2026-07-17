export const POSTGREST_PAGE_SIZE = 1000;

// PostgREST applies a response-size cap even when the caller omits a range.
// Keep pagination in one place so user-facing metrics never quietly stop at 1,000 rows.
export async function fetchAllPostgrestRows(fetchPage, { pageSize = POSTGREST_PAGE_SIZE } = {}) {
    const rows = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await fetchPage(from, from + pageSize - 1);
        if (error) throw error;
        const page = data || [];
        rows.push(...page);
        if (page.length < pageSize) return rows;
    }
}
