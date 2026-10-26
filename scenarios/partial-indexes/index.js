import * as simulation from './sim.js';

export default {
  category: 'database',
  topic: { en: 'SQL indexes', vi: 'Index SQL' },
  title: {
    en: 'The inbox that reads four million rows',
    vi: 'Hộp thư đọc bốn triệu dòng',
  },

  scenario: {
    en: `You run a helpdesk product on **PostgreSQL 16**. The \`tickets\` table has **120 million rows** from 30,000 customer organisations. Closed tickets are kept forever, so customers can search their history; at any moment only about **2% of tickets are open**.

Every agent's inbox runs this query, written by hand in the app's SQL:

\`\`\`
SELECT id, subject, assignee_id, priority, updated_at
FROM tickets
WHERE org_id = $1 AND status = 'open'
ORDER BY updated_at DESC
LIMIT 50;
\`\`\`

The table has three indexes: the primary key, \`(org_id)\` and \`(requester_id)\`. For a small organisation the inbox loads in a few milliseconds. For your largest customer, with **4 million tickets and about 40,000 open**, it takes **6 to 9 seconds**: the plan uses the \`org_id\` index, reads every one of their tickets, throws away the closed ones and sorts the rest.

Constraints:
- The inbox must load in **under 200 ms for every organisation**, including the largest.
- The database server's memory is nearly full with the table's hot pages and the existing indexes. You measured about **2 GB of spare cache**. Last year an index bigger than that pushed hot table pages out of memory, and every query on \`tickets\` got slower.
- Your size estimates for a new index: on \`(org_id, status, updated_at)\` for every row, **about 5 GB**; the same with \`INCLUDE (subject, assignee_id, priority)\`, **about 13 GB**; on open tickets only, **about 90 MB**.
- Every week a new customer **imports their history** from another helpdesk: millions of closed tickets in one night. The import already keeps the disk busy, so it **cannot take more index writes per row** than it does today.
- When an agent closes a ticket and reloads, the ticket must be gone from the inbox.
- Tickets change all day: every comment updates \`updated_at\`.`,
    vi: `Bạn vận hành một sản phẩm helpdesk trên **PostgreSQL 16**. Bảng \`tickets\` có **120 triệu dòng** từ 30.000 tổ chức khách hàng. Ticket đã đóng được giữ mãi mãi để khách tra cứu lịch sử; tại mỗi thời điểm chỉ khoảng **2% ticket đang mở**.

Hộp thư của mọi agent chạy truy vấn này, viết tay trong SQL của ứng dụng:

\`\`\`
SELECT id, subject, assignee_id, priority, updated_at
FROM tickets
WHERE org_id = $1 AND status = 'open'
ORDER BY updated_at DESC
LIMIT 50;
\`\`\`

Bảng có ba index: khoá chính, \`(org_id)\` và \`(requester_id)\`. Với một tổ chức nhỏ, hộp thư tải trong vài mili giây. Với khách hàng lớn nhất, có **4 triệu ticket và khoảng 40.000 ticket đang mở**, nó mất **6 tới 9 giây**: kế hoạch thực thi dùng index \`org_id\`, đọc toàn bộ ticket của họ, bỏ các ticket đã đóng rồi sắp xếp phần còn lại.

Ràng buộc:
- Hộp thư phải tải **dưới 200 ms với mọi tổ chức**, kể cả tổ chức lớn nhất.
- Bộ nhớ của máy chủ database gần đầy với các trang nóng của bảng và các index hiện có. Bạn đo được khoảng **2 GB cache còn trống**. Năm ngoái một index lớn hơn mức đó đã đẩy các trang nóng của bảng ra khỏi bộ nhớ, và mọi truy vấn trên \`tickets\` đều chậm đi.
- Ước tính kích thước của bạn cho một index mới: trên \`(org_id, status, updated_at)\` cho mọi dòng, **khoảng 5 GB**; cũng vậy nhưng thêm \`INCLUDE (subject, assignee_id, priority)\`, **khoảng 13 GB**; chỉ trên các ticket đang mở, **khoảng 90 MB**.
- Mỗi tuần có một khách hàng mới **nhập lịch sử** từ một hệ thống helpdesk khác: hàng triệu ticket đã đóng trong một đêm. Việc nhập đã khiến đĩa bận rộn, nên nó **không thể gánh thêm lượt ghi index cho mỗi dòng** so với hiện tại.
- Khi agent đóng một ticket rồi tải lại, ticket đó phải biến mất khỏi hộp thư.
- Ticket thay đổi suốt ngày: mỗi bình luận đều cập nhật \`updated_at\`.`,
  },

  question: {
    en: 'How do you make the inbox fast for every organisation?',
    vi: 'Bạn làm thế nào để hộp thư nhanh với mọi tổ chức?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'A partial index on open tickets only: `CREATE INDEX CONCURRENTLY ON tickets (org_id, updated_at DESC) WHERE status = \'open\'`.',
        vi: 'Một partial index chỉ trên ticket đang mở: `CREATE INDEX CONCURRENTLY ON tickets (org_id, updated_at DESC) WHERE status = \'open\'`.',
      },
      why: {
        en: 'The inbox only ever asks for open tickets, and they are 2% of the table, so index only them. The index holds about 2.4 million entries instead of 120 million, roughly 90 MB, which fits in the spare cache with room to spare. Its key matches the query exactly: equality on `org_id`, then `updated_at` in the order the inbox wants, so the largest organisation reads 50 entries and 50 rows and stops. Closed tickets do not match the predicate, so a closed ticket drops out of the inbox, and writing a closed row never touches this index: a night\'s import of millions of closed tickets costs exactly the index writes it costs today. `CONCURRENTLY` builds it without blocking writes. One condition makes it work: the planner uses a partial index only when the query\'s `WHERE` provably implies the predicate, which is why it matters that the query says `status = \'open\'` as a literal. Sent as a bind parameter (`status = $2`), it would never match.',
        vi: 'Hộp thư chỉ hỏi ticket đang mở, và chúng chiếm 2% bảng, nên chỉ index chúng. Index chứa khoảng 2,4 triệu mục thay vì 120 triệu, cỡ 90 MB, vừa vặn trong phần cache trống và còn dư. Khoá của nó khớp chính xác với truy vấn: so sánh bằng trên `org_id`, rồi `updated_at` theo đúng thứ tự hộp thư cần, nên tổ chức lớn nhất chỉ đọc 50 mục và 50 dòng rồi dừng. Ticket đã đóng không khớp điều kiện, nên một ticket vừa đóng biến khỏi hộp thư, và việc ghi một dòng đã đóng không bao giờ chạm tới index này: một đêm nhập hàng triệu ticket đã đóng tốn đúng số lượt ghi index như hiện tại. `CONCURRENTLY` xây index mà không chặn ghi. Có một điều kiện để nó hoạt động: planner chỉ dùng partial index khi `WHERE` của truy vấn chứng minh được là kéo theo điều kiện của index, vì vậy việc truy vấn viết `status = \'open\'` dạng literal là quan trọng. Nếu gửi dưới dạng tham số (`status = $2`), nó sẽ không bao giờ khớp.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'A composite B-tree on the whole table: `(org_id, status, updated_at DESC)`.',
        vi: 'Một B-tree tổng hợp trên toàn bảng: `(org_id, status, updated_at DESC)`.',
      },
      why: {
        en: 'The column order is right: two equality columns, then the sort column, so the largest organisation\'s inbox reads 50 entries and is fast. But it indexes all 120 million rows to serve a query that only wants the 2% that are open. At about 5 GB it is more than twice the spare cache, so under load it pushes the table\'s hot pages out of memory and every other query on `tickets` gets slower: the same incident as last year. 98% of the index is closed tickets that this query never reads, and every imported closed ticket now costs one more index write than it does today, which the import cannot afford. It would be the right index if the inbox also had to list closed tickets, or if memory were not tight.',
        vi: 'Thứ tự cột là đúng: hai cột so sánh bằng, rồi cột sắp xếp, nên hộp thư của tổ chức lớn nhất chỉ đọc 50 mục và chạy nhanh. Nhưng nó index cả 120 triệu dòng để phục vụ một truy vấn chỉ cần 2% đang mở. Với khoảng 5 GB, nó lớn hơn gấp đôi phần cache trống, nên khi tải cao nó đẩy các trang nóng của bảng ra khỏi bộ nhớ và mọi truy vấn khác trên `tickets` đều chậm đi: đúng sự cố năm ngoái. 98% index là ticket đã đóng mà truy vấn này không bao giờ đọc, và mỗi ticket đã đóng được nhập vào giờ tốn thêm một lượt ghi index so với hiện tại, điều mà việc nhập không gánh nổi. Đây sẽ là index đúng nếu hộp thư cũng phải liệt kê ticket đã đóng, hoặc nếu bộ nhớ không eo hẹp.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'A covering index for index-only scans: `(org_id, status, updated_at DESC) INCLUDE (subject, assignee_id, priority)`, so the query never visits the table.',
        vi: 'Một covering index cho index-only scan: `(org_id, status, updated_at DESC) INCLUDE (subject, assignee_id, priority)`, để truy vấn không bao giờ phải đọc bảng.',
      },
      why: {
        en: 'An index-only scan skips the table only for rows on pages the visibility map marks as all-visible. Open tickets are exactly the rows that change all day, since every comment updates them, so their pages are rarely all-visible and the scan visits the table for almost every row anyway. You pay for that with size: copying `subject` into every entry of a full-table index takes it to about 13 GB, six times the spare cache, and every imported row now writes a wide extra index entry. PostgreSQL\'s own docs advise against payload columns unless the table changes slowly enough for index-only scans to skip the heap.',
        vi: 'Index-only scan chỉ bỏ qua bảng với những dòng nằm trên trang mà visibility map đánh dấu là all-visible. Ticket đang mở chính là những dòng thay đổi suốt ngày, vì mỗi bình luận đều cập nhật chúng, nên trang của chúng hiếm khi all-visible và lần quét vẫn phải đọc bảng cho gần như mọi dòng. Cái giá phải trả là kích thước: chép `subject` vào mọi mục của một index trên toàn bảng làm nó lên khoảng 13 GB, gấp sáu lần phần cache trống, và mỗi dòng được nhập giờ phải ghi thêm một mục index rộng. Chính tài liệu PostgreSQL khuyên không nên thêm cột payload trừ khi bảng thay đổi đủ chậm để index-only scan bỏ qua được heap.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Leave the primary alone: route inbox queries to a streaming read replica, so their work never touches the primary\'s cache.',
        vi: 'Không đụng tới primary: chuyển truy vấn hộp thư sang một read replica streaming, để công việc của chúng không bao giờ chạm vào cache của primary.',
      },
      why: {
        en: 'A replica moves the load; it does not make the query cheaper. A streaming replica is a physical copy of the primary and cannot run `CREATE INDEX`, so it has exactly the same indexes: the largest organisation\'s inbox still reads 4 million rows and still takes seconds, only on another machine. It also breaks the freshness requirement. The replica replays the primary\'s changes with a delay, so an agent who closes a ticket and reloads at once can still see it in the inbox. Replicas are the right tool for read capacity and for reports that can be a little stale, not for a query that needs a better access path.',
        vi: 'Replica chuyển tải đi chỗ khác; nó không làm truy vấn rẻ hơn. Một replica streaming là bản sao vật lý của primary và không chạy được `CREATE INDEX`, nên nó có đúng các index như primary: hộp thư của tổ chức lớn nhất vẫn đọc 4 triệu dòng và vẫn mất vài giây, chỉ là trên một máy khác. Nó còn phá vỡ yêu cầu về độ mới. Replica áp dụng lại thay đổi của primary với độ trễ, nên một agent vừa đóng ticket rồi tải lại ngay vẫn có thể thấy nó trong hộp thư. Replica là công cụ đúng cho năng lực đọc và cho báo cáo chấp nhận hơi cũ, không phải cho một truy vấn cần đường truy cập tốt hơn.',
      },
    },
  ],

  answer: 'A',

  takeaway: {
    en: `**Index the rows your query asks for, not the whole table.** When a hot query always filters to a small, stable subset (open tickets, unpaid invoices, active sessions), a partial index is small, cheap to keep in memory, and skips index maintenance for every row outside it. Every index is paid for on every write of a row it covers; a partial index covers fewer rows.

- **Column order** in a B-tree: equality columns first, then the column you sort or range over. Then \`LIMIT 50\` reads 50 entries.
- **A partial index is used only when the query's \`WHERE\` implies its predicate** at planning time. Write the condition as a literal; a bind parameter never matches.
- **Predicates must be immutable.** \`WHERE created_at > now() - interval '7 days'\` is rejected, because \`now()\` changes. For "recent rows", index the time column instead, or partition by time.
- **Covering indexes (\`INCLUDE\`)** pay off on tables that change slowly. On busy tables, the visibility map sends the scan to the heap anyway.
- **Measure the index against memory**, not just against the query. Every index has to live in cache to be fast, and it takes that cache from something else.
- **A physical replica has the primary's indexes and lags behind it.** It adds read capacity, not a better plan.
- Build indexes on a live table with \`CREATE INDEX CONCURRENTLY\`.`,
    vi: `**Hãy index những dòng truy vấn cần, không phải cả bảng.** Khi một truy vấn nóng luôn lọc về một tập con nhỏ và ổn định (ticket đang mở, hoá đơn chưa thanh toán, phiên đang hoạt động), partial index sẽ nhỏ, dễ giữ trong bộ nhớ, và không phải bảo trì index cho mọi dòng nằm ngoài nó. Mỗi index đều phải trả giá ở mỗi lần ghi một dòng nó bao phủ; partial index bao phủ ít dòng hơn.

- **Thứ tự cột** trong B-tree: các cột so sánh bằng trước, rồi tới cột dùng để sắp xếp hoặc lọc theo khoảng. Khi đó \`LIMIT 50\` chỉ đọc 50 mục.
- **Partial index chỉ được dùng khi \`WHERE\` của truy vấn kéo theo điều kiện của index** tại thời điểm lập kế hoạch. Hãy viết điều kiện dạng literal; tham số bind không bao giờ khớp.
- **Điều kiện phải là immutable.** \`WHERE created_at > now() - interval '7 days'\` bị từ chối, vì \`now()\` thay đổi. Với "các dòng gần đây", hãy index cột thời gian, hoặc partition theo thời gian.
- **Covering index (\`INCLUDE\`)** có lợi trên bảng thay đổi chậm. Trên bảng bận rộn, visibility map vẫn buộc lần quét quay lại heap.
- **Đo index so với bộ nhớ**, không chỉ so với truy vấn. Mọi index đều phải nằm trong cache mới nhanh, và nó lấy phần cache đó từ thứ khác.
- **Replica vật lý có đúng các index của primary và chạy chậm hơn nó.** Nó thêm năng lực đọc, không thêm kế hoạch tốt hơn.
- Xây index trên bảng đang chạy bằng \`CREATE INDEX CONCURRENTLY\`.`,
  },

  sources: [
    { title: 'PostgreSQL documentation: Partial Indexes (when the planner can use them; parameterized clauses)', url: 'https://www.postgresql.org/docs/current/indexes-partial.html' },
    { title: 'PostgreSQL documentation: Multicolumn Indexes', url: 'https://www.postgresql.org/docs/current/indexes-multicolumn.html' },
    { title: 'PostgreSQL documentation: Index-Only Scans and Covering Indexes (the visibility map)', url: 'https://www.postgresql.org/docs/current/indexes-index-only-scans.html' },
    { title: 'PostgreSQL documentation: CREATE INDEX (immutable predicates, CONCURRENTLY)', url: 'https://www.postgresql.org/docs/current/sql-createindex.html' },
    { title: 'PostgreSQL documentation: Hot Standby (no DDL on a standby; eventual consistency)', url: 'https://www.postgresql.org/docs/current/hot-standby.html' },
  ],

  simulation,
};
