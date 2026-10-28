import * as simulation from './sim.js';

export default {
  category: 'database',
  topic: { en: 'N+1 queries', vi: 'Truy vấn N+1' },
  title: {
    en: '201 fast queries',
    vi: '201 truy vấn nhanh',
  },

  scenario: {
    en: `You maintain a helpdesk product. Support agents live on the queue page: **100 tickets per page**, newest activity first, each row showing the assignee's name and the ticket's tags.

The page got slow as the product grew. The database's CPU is low, and every query in the slow-query log is fast. Then you turn on per-request query logging for one page load:

\`\`\`
SELECT * FROM tickets WHERE queue_id = 7
  ORDER BY updated_at DESC LIMIT 100 OFFSET 0         2.8 ms
SELECT * FROM agents WHERE id = 412                    0.9 ms
SELECT tags.* FROM tags JOIN ticket_tags ...
  WHERE ticket_tags.ticket_id = 88121                  1.0 ms
SELECT * FROM agents WHERE id = 37                     0.9 ms
...
201 queries, ~200 ms of database time per page
\`\`\`

The template reads \`ticket.assignee.name\` and loops over \`ticket.tags\`. Each of those triggers a lazy load from the ORM: two queries per ticket, plus one for the page. No single query is slow. There are just 201 of them, each paying a network round trip.

Constraints:
- The queue is paginated, 100 tickets per page, and the page must show every tag of every ticket on it.
- Most tickets have a handful of tags. Tickets touched by automation rules can carry **30 or more**.
- Tags change all the time: automation rules add and remove them many times a minute, and admins sometimes rename a tag that sits on millions of tickets.
- The fix should live in the data-access code. No new infrastructure for this page.`,
    vi: `Bạn bảo trì một sản phẩm helpdesk. Nhân viên hỗ trợ làm việc cả ngày trên trang hàng đợi: **100 ticket mỗi trang**, hoạt động mới nhất lên đầu, mỗi dòng hiện tên người được giao và các tag của ticket.

Trang chậm dần khi sản phẩm lớn lên. CPU của database thấp, và mọi truy vấn trong slow-query log đều nhanh. Rồi bạn bật log truy vấn theo từng request cho một lần tải trang:

\`\`\`
SELECT * FROM tickets WHERE queue_id = 7
  ORDER BY updated_at DESC LIMIT 100 OFFSET 0         2.8 ms
SELECT * FROM agents WHERE id = 412                    0.9 ms
SELECT tags.* FROM tags JOIN ticket_tags ...
  WHERE ticket_tags.ticket_id = 88121                  1.0 ms
SELECT * FROM agents WHERE id = 37                     0.9 ms
...
201 truy vấn, ~200 ms thời gian database mỗi trang
\`\`\`

Template đọc \`ticket.assignee.name\` và lặp qua \`ticket.tags\`. Mỗi chỗ đó khiến ORM lazy load: hai truy vấn cho mỗi ticket, cộng một cho cả trang. Không truy vấn nào chậm. Chỉ là có tới 201 cái, cái nào cũng tốn một vòng mạng.

Ràng buộc:
- Hàng đợi được phân trang, 100 ticket mỗi trang, và trang phải hiện đủ mọi tag của mọi ticket trên đó.
- Phần lớn ticket có vài tag. Ticket bị automation rule xử lý có thể mang **30 tag trở lên**.
- Tag thay đổi liên tục: automation rule thêm và bỏ tag nhiều lần mỗi phút, và đôi khi admin đổi tên một tag đang nằm trên hàng triệu ticket.
- Cách sửa phải nằm trong code truy cập dữ liệu. Không thêm hạ tầng mới cho trang này.`,
  },

  question: {
    en: 'How do you load the page?',
    vi: 'Bạn tải trang này thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Cache each agent and each ticket\'s tag list in Redis for 5 minutes, so the per-ticket lookups hit memory instead of the database.',
        vi: 'Cache từng agent và danh sách tag của từng ticket trong Redis trong 5 phút, để các lần tra cứu theo ticket đọc từ bộ nhớ thay vì database.',
      },
      why: {
        en: 'The page still makes 200 lookups, one network round trip each. They now go to Redis instead of Postgres, so the time per lookup drops but the count does not. Tags change many times a minute, so the cached tag lists need invalidating on every change, or agents see stale tags. A tag rename has to clear millions of entries. And it adds infrastructure, which the constraints rule out. Caching is for expensive queries. These queries are cheap. There are just too many of them.',
        vi: 'Trang vẫn thực hiện 200 lần tra cứu, mỗi lần một vòng mạng. Giờ chúng đi tới Redis thay vì Postgres, nên mỗi lần nhanh hơn nhưng số lần không giảm. Tag đổi nhiều lần mỗi phút, nên danh sách tag trong cache phải bị xoá mỗi lần đổi, nếu không nhân viên sẽ thấy tag cũ. Một lần đổi tên tag phải xoá hàng triệu mục. Và nó thêm hạ tầng, điều ràng buộc không cho phép. Cache dành cho truy vấn tốn kém. Các truy vấn này rẻ. Chỉ là có quá nhiều.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Eager-load with one query: join tickets to agents and to tags, keep `LIMIT 100`, and build the page from the joined rows.',
        vi: 'Eager load bằng một truy vấn: join tickets với agents và tags, giữ `LIMIT 100`, rồi dựng trang từ các dòng đã join.',
      },
      why: {
        en: 'Joining the assignee is fine: one agent per ticket, one row per ticket. Joining tags is not. A ticket with 30 tags becomes 30 rows, and `LIMIT 100` counts rows, not tickets. The page comes back with far fewer than 100 tickets, and the last one can be missing some of its tags. That breaks both the pagination and the "every tag" requirement. Some ORMs notice and drop the `LIMIT` from the SQL, then paginate in memory, which loads the whole queue on every page view. Hibernate logs warning HHH000104 when it does this. Joins work well for single-valued relations. For collections under pagination, page the parent IDs first.',
        vi: 'Join người được giao thì ổn: mỗi ticket một agent, mỗi ticket một dòng. Join tag thì không. Ticket có 30 tag thành 30 dòng, và `LIMIT 100` đếm dòng chứ không đếm ticket. Trang trả về ít hơn 100 ticket rất nhiều, và ticket cuối có thể thiếu một số tag. Như vậy hỏng cả phân trang lẫn yêu cầu "đủ mọi tag". Một số ORM phát hiện ra, bỏ `LIMIT` khỏi SQL rồi phân trang trong bộ nhớ, tức là tải cả hàng đợi mỗi lần xem trang. Hibernate ghi cảnh báo HHH000104 khi làm vậy. Join rất hợp với quan hệ một-giá-trị. Với collection khi có phân trang, hãy phân trang ID của bản ghi cha trước.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Batch-load each relation: run the page query, then one `WHERE id IN (...)` query for the assignees and one `WHERE ticket_id IN (...)` query for the tags, and stitch them together in code.',
        vi: 'Batch load từng quan hệ: chạy truy vấn trang, rồi một truy vấn `WHERE id IN (...)` cho người được giao và một truy vấn `WHERE ticket_id IN (...)` cho tag, sau đó ghép lại trong code.',
      },
      why: {
        en: 'Three queries per page, whatever the page size and however many tags a ticket has. The `LIMIT` stays on the tickets query, so pagination is exact, and the tag query returns every tag of those 100 tickets. Each `IN` list holds at most 100 IDs. Data is read fresh on every page view, so tag changes and renames show up at once and nothing needs invalidating. Most ORMs do this for you: `prefetch_related` in Django, `preload` in Rails, batch fetching in Hibernate, DataLoader in GraphQL servers. Joining the assignee instead of batching it is equally fine. The rule that matters is: never join a collection under a `LIMIT`.',
        vi: 'Ba truy vấn mỗi trang, bất kể kích thước trang hay một ticket có bao nhiêu tag. `LIMIT` vẫn nằm trên truy vấn tickets, nên phân trang chính xác, và truy vấn tag trả về mọi tag của 100 ticket đó. Mỗi danh sách `IN` có tối đa 100 ID. Dữ liệu được đọc mới mỗi lần xem trang, nên thay đổi và đổi tên tag hiện ra ngay và không có gì phải xoá cache. Phần lớn ORM làm sẵn việc này: `prefetch_related` trong Django, `preload` trong Rails, batch fetching trong Hibernate, DataLoader trong các GraphQL server. Join người được giao thay vì batch cũng ổn như nhau. Quy tắc quan trọng là: đừng bao giờ join một collection dưới `LIMIT`.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Denormalize: store the assignee\'s name and the tag names on the tickets row, so the page needs a single query.',
        vi: 'Phi chuẩn hoá: lưu tên người được giao và tên các tag ngay trên dòng tickets, để trang chỉ cần một truy vấn.',
      },
      why: {
        en: 'Reads become one query, but every write gets heavier. Each time automation adds or removes a tag, the copy on the ticket must change too, in the same transaction or it drifts. A tag rename becomes an update across millions of rows. An agent changing their display name touches every ticket assigned to them. You trade a read problem with a simple, well-known fix for a write problem that never goes away. Denormalize when the data is read-mostly and rarely changes, or when one query really must serve the page and you have measured that three cannot.',
        vi: 'Đọc chỉ còn một truy vấn, nhưng mọi lần ghi nặng hơn. Mỗi lần automation thêm hay bỏ một tag, bản sao trên ticket cũng phải đổi theo, trong cùng transaction, nếu không nó sẽ lệch. Đổi tên một tag thành cập nhật hàng triệu dòng. Một agent đổi tên hiển thị là đụng tới mọi ticket được giao cho họ. Bạn đổi một vấn đề đọc vốn có cách sửa đơn giản, quen thuộc lấy một vấn đề ghi không bao giờ hết. Hãy phi chuẩn hoá khi dữ liệu chủ yếu được đọc và hiếm khi đổi, hoặc khi trang thật sự phải chỉ dùng một truy vấn và bạn đã đo được rằng ba truy vấn là không đủ.',
      },
    },
  ],

  answer: 'C',

  takeaway: {
    en: `N+1 is a round-trip problem, not a slow-query problem. Each query looks fine on its own, so the slow-query log never shows it. Count queries per request instead.

- **Batch loading** (\`IN (...)\` per relation) makes the query count constant: one per relation, whatever the page size.
- **Joins** are the right eager load for single-valued relations. Joining a collection multiplies rows and breaks \`LIMIT\`.
- Catch it before production: log or assert the number of queries per request in tests, so a new lazy load in a template fails a build instead of paging someone.`,
    vi: `N+1 là vấn đề số vòng mạng, không phải vấn đề truy vấn chậm. Từng truy vấn riêng lẻ trông đều ổn, nên slow-query log không bao giờ bắt được nó. Hãy đếm số truy vấn mỗi request.

- **Batch load** (\`IN (...)\` cho từng quan hệ) làm số truy vấn không đổi: mỗi quan hệ một cái, bất kể kích thước trang.
- **Join** là cách eager load đúng cho quan hệ một-giá-trị. Join một collection sẽ nhân số dòng và làm hỏng \`LIMIT\`.
- Bắt nó trước khi lên production: log hoặc assert số truy vấn mỗi request trong test, để một lazy load mới trong template làm hỏng build thay vì đánh thức ai đó lúc nửa đêm.`,
  },

  sources: [
    { title: 'Django documentation: select_related() and prefetch_related()', url: 'https://docs.djangoproject.com/en/5.1/ref/models/querysets/#prefetch-related' },
    { title: 'Rails Guides: Active Record Query Interface, Eager Loading Associations', url: 'https://guides.rubyonrails.org/active_record_querying.html#eager-loading-associations' },
    { title: 'Vlad Mihalcea: Fixing the Hibernate HHH000104 entity fetch pagination warning', url: 'https://vladmihalcea.com/fix-hibernate-hhh000104-entity-fetch-pagination-warning-message/' },
    { title: 'GraphQL: DataLoader', url: 'https://github.com/graphql/dataloader' },
  ],

  simulation,
};
