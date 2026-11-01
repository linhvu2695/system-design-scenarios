import * as simulation from './sim.js';

export default {
  category: 'database',
  topic: { en: 'Pagination', vi: 'Phân trang' },
  title: {
    en: 'The export that slows down as it goes',
    vi: 'Bản export càng chạy càng chậm',
  },

  scenario: {
    en: `You run a payments platform on **PostgreSQL**. Merchants see their payments in a dashboard, newest first, and accounting tools pull them through your public API:

\`\`\`
GET /v1/payments?page=150000      → 100 payments, newest first
\`\`\`

Behind it:

\`\`\`
SELECT * FROM payments
WHERE merchant_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 100 OFFSET ($2 - 1) * 100;
\`\`\`

The index on \`(merchant_id, created_at DESC, id DESC)\` already exists, and \`id\` is a unique bigint. Your largest merchant has **18 million payments**, so 180,000 pages.

What you see:
- The dashboard is fine. Page 1 comes back in **about 2 ms**, and agents rarely go past page 10.
- Every night, accounting integrations **walk a merchant's whole history**, page after page. For the largest merchant, requests pass 150 ms around **page 3,500**, and by **page 150,000** each one takes **about 6.5 seconds**.
- During that walk, the merchant keeps taking payments, **hundreds a minute** at peak, and they appear at the top of the newest-first list.
- Payout jobs create **thousands of payments in one transaction**. Their \`created_at\` defaults to \`now()\`, so every payment in a batch has the same timestamp.

What the fix must do:
- **Every page under 150 ms**, at any depth.
- **Every payment exactly once** in a walk, while new payments keep arriving: no duplicates, no gaps.
- Keep the **newest-first** order. The product team has agreed to drop page numbers: next and previous are enough.`,
    vi: `Bạn vận hành một nền tảng thanh toán trên **PostgreSQL**. Merchant xem các thanh toán của họ trên dashboard, mới nhất trước, và các công cụ kế toán kéo chúng về qua API công khai của bạn:

\`\`\`
GET /v1/payments?page=150000      → 100 thanh toán, mới nhất trước
\`\`\`

Phía sau nó:

\`\`\`
SELECT * FROM payments
WHERE merchant_id = $1
ORDER BY created_at DESC, id DESC
LIMIT 100 OFFSET ($2 - 1) * 100;
\`\`\`

Index trên \`(merchant_id, created_at DESC, id DESC)\` đã có sẵn, và \`id\` là một bigint duy nhất. Merchant lớn nhất của bạn có **18 triệu thanh toán**, tức 180.000 trang.

Những gì bạn thấy:
- Dashboard vẫn ổn. Trang 1 trả về trong **khoảng 2 ms**, và nhân viên hỗ trợ hiếm khi đi quá trang 10.
- Mỗi đêm, các tích hợp kế toán **duyệt toàn bộ lịch sử** của một merchant, hết trang này tới trang khác. Với merchant lớn nhất, request vượt 150 ms quanh **trang 3.500**, và tới **trang 150.000** thì mỗi request mất **khoảng 6,5 giây**.
- Trong lúc duyệt, merchant vẫn tiếp tục nhận thanh toán, **hàng trăm mỗi phút** vào giờ cao điểm, và chúng xuất hiện ở đầu danh sách mới nhất trước.
- Các job chi trả tạo **hàng nghìn thanh toán trong một transaction**. \`created_at\` của chúng mặc định là \`now()\`, nên mọi thanh toán trong một lô có cùng một timestamp.

Cách sửa phải làm được:
- **Mọi trang dưới 150 ms**, ở bất kỳ độ sâu nào.
- **Mỗi thanh toán đúng một lần** trong một lượt duyệt, trong khi thanh toán mới vẫn liên tục tới: không trùng, không sót.
- Giữ thứ tự **mới nhất trước**. Team sản phẩm đã đồng ý bỏ số trang: trang trước và trang sau là đủ.`,
  },

  question: {
    en: 'How do you change the pagination?',
    vi: 'Bạn thay đổi cách phân trang thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Keep `?page=N`, but rewrite the query as a deferred join: find the page\'s 100 ids with `OFFSET` in an index-only subquery, then join back to `payments` for the full rows.',
        vi: 'Giữ `?page=N`, nhưng viết lại truy vấn thành deferred join: tìm 100 id của trang bằng `OFFSET` trong một subquery chỉ đọc index, rồi join ngược về `payments` để lấy dòng đầy đủ.',
      },
      why: {
        en: 'It makes each skipped row cheaper: the subquery steps over index entries without fetching their table rows, which works as an index-only scan on old payments that the visibility map marks all-visible. But it still steps over every one of them. At page 150,000 that is 15 million entries, so the request takes over a second instead of 6.5: the cliff moves from page 3,500 to around page 18,000, and the export still falls off it. It also keeps the counting problem: when new payments arrive at the top, every row moves down, and the next `OFFSET` returns rows the export already has.',
        vi: 'Nó làm mỗi dòng bị bỏ qua rẻ hơn: subquery bước qua các mục index mà không lấy dòng của chúng trong bảng, một index-only scan chạy được trên các thanh toán cũ mà visibility map đánh dấu all-visible. Nhưng nó vẫn phải bước qua từng mục một. Ở trang 150.000 đó là 15 triệu mục, nên request mất hơn một giây thay vì 6,5: vực thẳm dời từ trang 3.500 tới khoảng trang 18.000, và bản export vẫn rơi xuống. Nó cũng giữ nguyên vấn đề đếm: khi thanh toán mới tới ở đầu danh sách, mọi dòng bị đẩy xuống, và `OFFSET` tiếp theo trả về những dòng export đã có.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'A cursor on `(created_at, id)`: each response returns an opaque `next_cursor` that encodes the last row\'s `created_at` and `id`, and the next query adds `AND (created_at, id) < ($t, $id)`.',
        vi: 'Một cursor trên `(created_at, id)`: mỗi response trả về một `next_cursor` mờ (opaque) mã hoá `created_at` và `id` của dòng cuối, và truy vấn tiếp theo thêm `AND (created_at, id) < ($t, $id)`.',
      },
      why: {
        en: 'The cursor is a place, not a count. PostgreSQL compares the two values left to right, so the condition means "an older time, or the same time and a smaller id", which is exactly the index order. The database goes down the existing index straight to that spot and reads 100 entries, so page 150,000 costs the same as page 1. New payments sort above the cursor and never shift what comes after it, and the `id` breaks ties, so a payout batch that shares one timestamp is split across pages without losing a row. Previous is the same query with `>` and the order reversed. Keeping the cursor opaque lets you change what it holds later without breaking the integrations. The price is that there are no page numbers or jumps, which the product team has already given up.',
        vi: 'Cursor là một vị trí, không phải một con số đếm. PostgreSQL so sánh hai giá trị từ trái sang phải, nên điều kiện có nghĩa là "thời điểm cũ hơn, hoặc cùng thời điểm và id nhỏ hơn", đúng bằng thứ tự của index. Database đi xuống index có sẵn thẳng tới chỗ đó và đọc 100 mục, nên trang 150.000 tốn đúng bằng trang 1. Thanh toán mới nằm phía trên cursor và không bao giờ làm xê dịch những gì phía sau nó, còn `id` phân xử các dòng trùng thời điểm, nên một lô chi trả có chung một timestamp được chia qua các trang mà không mất dòng nào. Trang trước là cùng truy vấn đó với `>` và thứ tự đảo ngược. Giữ cursor ở dạng mờ cho phép bạn đổi nội dung bên trong sau này mà không làm hỏng các tích hợp. Cái giá là không còn số trang hay nhảy trang, điều team sản phẩm đã chấp nhận bỏ.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Keep `OFFSET`, but have exports walk oldest first (`ORDER BY created_at, id`), so new payments land at the end instead of shifting the pages ahead of the export.',
        vi: 'Giữ `OFFSET`, nhưng cho export duyệt từ cũ nhất (`ORDER BY created_at, id`), để thanh toán mới rơi vào cuối thay vì làm xê dịch các trang phía trước bản export.',
      },
      why: {
        en: 'It does fix the duplicates: new payments sort after everything the export has read, so the rows ahead of it stay where they were. (Deletes would still shift them, but payments are not deleted here.) It does nothing for speed. `OFFSET` is still a count, so page 150,000 still reads and throws away 15 million rows, about 6.5 seconds, whichever end it counts from. It also breaks the stated requirement to keep the newest-first order.',
        vi: 'Nó đúng là sửa được chuyện trùng lặp: thanh toán mới nằm sau mọi thứ bản export đã đọc, nên các dòng phía trước nó giữ nguyên chỗ. (Lệnh xoá vẫn làm chúng xê dịch, nhưng ở đây thanh toán không bị xoá.) Nó không giúp gì cho tốc độ. `OFFSET` vẫn là một con số đếm, nên trang 150.000 vẫn đọc rồi vứt đi 15 triệu dòng, khoảng 6,5 giây, dù đếm từ đầu nào. Nó cũng phá yêu cầu đã nêu là giữ thứ tự mới nhất trước.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'A cursor on the timestamp alone: return the last row\'s `created_at`, and fetch the next page with `WHERE created_at < $t`.',
        vi: 'Một cursor chỉ trên timestamp: trả về `created_at` của dòng cuối, và lấy trang tiếp theo bằng `WHERE created_at < $t`.',
      },
      why: {
        en: 'It has the speed of a cursor, and new payments do not disturb it, but `created_at` is not unique here. When a page ends in the middle of a payout batch, every payment in the batch has the same timestamp, so `created_at < $t` skips all the ones the export has not seen yet. They never arrive, and nothing reports the gap. Switching to `<=` swaps the gap for duplicates, and if a batch is bigger than a page the walk never gets past it. A cursor needs a key that is unique, so add the `id` as a tie-breaker, both in the cursor and in the `ORDER BY`.',
        vi: 'Nó có tốc độ của một cursor, và thanh toán mới không làm phiền nó, nhưng `created_at` không duy nhất ở đây. Khi một trang kết thúc giữa một lô chi trả, mọi thanh toán trong lô có cùng một timestamp, nên `created_at < $t` bỏ qua hết những dòng export chưa thấy. Chúng không bao giờ tới, và không có gì báo về khoảng trống đó. Đổi sang `<=` thì đổi khoảng trống lấy trùng lặp, và nếu một lô lớn hơn một trang thì lượt duyệt không bao giờ qua được nó. Cursor cần một khoá duy nhất, nên hãy thêm `id` làm cột phân xử, cả trong cursor lẫn trong `ORDER BY`.',
      },
    },
  ],

  answer: 'B',

  takeaway: {
    en: `**OFFSET is a count; a cursor is a place.** To serve \`OFFSET 15000000\`, the database has to produce and discard 15 million rows, because it cannot know where row 15,000,001 is without counting. A cursor (also called keyset or seek pagination) remembers the last row's sort key and asks for what comes after it, which an index can find in a few page reads at any depth.

- **Shallow pages hide the problem.** OFFSET costs grow with depth, so a dashboard that never goes past page 10 looks fine, and the first deep client, often an export or a crawler, finds the cliff.
- **The sort key must be unique.** Add a tie-breaker such as \`id\`, both in \`ORDER BY\` and in the cursor. Timestamps collide more than you think: \`now()\` returns the transaction's start time, so a whole batch shares one value.
- **Row comparison** \`(created_at, id) < ($1, $2)\` is the compact way to say it in PostgreSQL, and it can use the index directly. Some databases need it spelled out: \`created_at < $1 OR (created_at = $1 AND id < $2)\`.
- **The index must match the sort**, including the filter columns first: here \`(merchant_id, created_at DESC, id DESC)\`.
- **Make cursors opaque** (for example base64 of a small JSON). Clients pass them back without reading them, and you can change what is inside.
- **What you give up:** page numbers, jumping to page N, and usually a total count. Offer "jump to a date" instead, which is just a cursor that starts at a timestamp.
- Deferred joins and covering indexes make each skipped row cheaper. They are worth having when users really need page numbers, but they only move the cliff further out.`,
    vi: `**OFFSET là một con số đếm; cursor là một vị trí.** Để phục vụ \`OFFSET 15000000\`, database phải tạo ra rồi vứt đi 15 triệu dòng, vì nó không thể biết dòng thứ 15.000.001 nằm ở đâu nếu không đếm. Cursor (còn gọi là keyset hay seek pagination) nhớ khoá sắp xếp của dòng cuối và xin những gì nằm sau nó, điều mà index tìm ra chỉ bằng vài lần đọc trang ở bất kỳ độ sâu nào.

- **Trang nông che giấu vấn đề.** Chi phí của OFFSET tăng theo độ sâu, nên một dashboard không bao giờ đi quá trang 10 trông vẫn ổn, và client sâu đầu tiên, thường là một bản export hay một crawler, mới tìm ra vực thẳm.
- **Khoá sắp xếp phải là duy nhất.** Thêm một cột phân xử như \`id\`, cả trong \`ORDER BY\` lẫn trong cursor. Timestamp trùng nhau nhiều hơn bạn tưởng: \`now()\` trả về thời điểm bắt đầu transaction, nên cả một lô dùng chung một giá trị.
- **So sánh hàng** \`(created_at, id) < ($1, $2)\` là cách viết gọn trong PostgreSQL, và nó dùng index trực tiếp được. Một số database cần viết đầy đủ: \`created_at < $1 OR (created_at = $1 AND id < $2)\`.
- **Index phải khớp với thứ tự sắp xếp**, gồm cả các cột lọc đứng trước: ở đây là \`(merchant_id, created_at DESC, id DESC)\`.
- **Làm cursor ở dạng mờ** (ví dụ base64 của một JSON nhỏ). Client gửi lại mà không đọc nội dung, và bạn có thể thay đổi những gì bên trong.
- **Những gì phải bỏ:** số trang, nhảy tới trang N, và thường là cả tổng số lượng. Hãy cung cấp "nhảy tới một ngày" thay thế, vốn chỉ là một cursor bắt đầu ở một timestamp.
- Deferred join và covering index làm mỗi dòng bị bỏ qua rẻ hơn. Chúng đáng dùng khi người dùng thật sự cần số trang, nhưng chúng chỉ đẩy vực thẳm ra xa hơn.`,
  },

  sources: [
    { title: 'PostgreSQL documentation: LIMIT and OFFSET (skipped rows are still computed)', url: 'https://www.postgresql.org/docs/current/queries-limit.html' },
    { title: 'PostgreSQL documentation: Row Constructor Comparison', url: 'https://www.postgresql.org/docs/current/functions-comparisons.html' },
    { title: 'PostgreSQL documentation: Current Date/Time (now() is the transaction start time)', url: 'https://www.postgresql.org/docs/current/functions-datetime.html' },
    { title: 'Markus Winand, Use The Index, Luke: Paging Through Results (the seek method)', url: 'https://use-the-index-luke.com/sql/partial-results/fetch-next-page' },
    { title: 'Markus Winand: We need tool support for keyset pagination (No Offset)', url: 'https://use-the-index-luke.com/no-offset' },
    { title: 'Slack Engineering: Evolving API Pagination at Slack', url: 'https://slack.engineering/evolving-api-pagination-at-slack/' },
    { title: 'Stripe API reference: Pagination (starting_after, ending_before)', url: 'https://docs.stripe.com/api/pagination' },
    { title: 'PlanetScale: Introducing FastPage, faster offset pagination for Rails apps (deferred joins)', url: 'https://planetscale.com/blog/fastpage-faster-offset-pagination-for-rails-apps' },
  ],

  simulation,
};
