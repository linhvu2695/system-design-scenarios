import * as simulation from './sim.js';

export default {
  category: 'database',
  topic: { en: 'Connection pooling', vi: 'Connection pooling' },
  title: {
    en: 'Six hundred connections, one clinic’s data',
    vi: 'Sáu trăm kết nối, dữ liệu của một phòng khám',
  },

  scenario: {
    en: `You run appointment booking for **3,000 clinics** on one PostgreSQL 16 server (16 cores). Clinics must never see each other's data, so every table has a **row-level security** policy that reads \`current_setting('app.clinic_id')\`.

The API runs on Kubernetes. Each pod keeps a client-side pool of **20 connections** open to the database. A request does this:

\`\`\`
SET app.clinic_id = '17';           -- who is asking
BEGIN;
SELECT … FROM appointments …;       -- RLS filters to clinic 17
UPDATE …;
COMMIT;                              -- about 5 ms in all
\`\`\`

Most of the week the API runs **6 pods**: 120 connections, well under \`max_connections = 200\`. On Monday mornings the autoscaler goes to **30 pods**: 600 connections are requested, Postgres answers \`FATAL: sorry, too many clients already\`, and bookings fail for half an hour. Almost all of those connections sit idle: a pod holds 20 open, but a 5 ms transaction rarely needs more than one or two at once.

Constraints:
- The Monday scale-out must work: up to **600 client connections** at once.
- **Tenant isolation is not negotiable.** One clinic seeing another clinic's appointments is a reportable incident.
- The database server stays as it is: 16 cores, and the memory each connection's queries can use is already tuned.
- You can change the API's data-access code. It lives in one module.`,
    vi: `Bạn vận hành hệ thống đặt lịch hẹn cho **3.000 phòng khám** trên một máy chủ PostgreSQL 16 (16 nhân). Các phòng khám không bao giờ được thấy dữ liệu của nhau, nên mọi bảng đều có chính sách **row-level security** đọc \`current_setting('app.clinic_id')\`.

API chạy trên Kubernetes. Mỗi pod giữ một pool phía client gồm **20 kết nối** mở tới database. Một request làm như sau:

\`\`\`
SET app.clinic_id = '17';           -- ai đang hỏi
BEGIN;
SELECT … FROM appointments …;       -- RLS lọc theo phòng khám 17
UPDATE …;
COMMIT;                              -- tổng cộng khoảng 5 ms
\`\`\`

Phần lớn thời gian trong tuần API chạy **6 pod**: 120 kết nối, dưới xa \`max_connections = 200\`. Mỗi sáng thứ Hai autoscaler tăng lên **30 pod**: 600 kết nối được yêu cầu, Postgres trả lời \`FATAL: sorry, too many clients already\`, và việc đặt lịch thất bại suốt nửa tiếng. Gần như mọi kết nối đó đều rảnh: một pod giữ 20 kết nối mở, nhưng một transaction 5 ms hiếm khi cần quá một hai kết nối cùng lúc.

Ràng buộc:
- Đợt scale-out sáng thứ Hai phải chạy được: tới **600 kết nối client** cùng lúc.
- **Cô lập dữ liệu giữa các phòng khám là bắt buộc.** Một phòng khám thấy lịch hẹn của phòng khám khác là sự cố phải báo cáo.
- Máy chủ database giữ nguyên: 16 nhân, và bộ nhớ mà truy vấn của mỗi kết nối được dùng đã được tinh chỉnh.
- Bạn có thể sửa code truy cập dữ liệu của API. Nó nằm trong một module.`,
  },

  question: {
    en: 'How do you get through Monday morning?',
    vi: 'Bạn vượt qua sáng thứ Hai thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Raise `max_connections` to 1,000 so every pod’s pool fits, with room to grow.',
        vi: 'Tăng `max_connections` lên 1.000 để pool của mọi pod đều vừa, còn dư chỗ để tăng.',
      },
      why: {
        en: 'The error goes away, and the problem moves. PostgreSQL runs a process per connection, and nothing in front of it queues the work. When a Monday burst puts hundreds of requests in flight at once, hundreds of processes run at once on 16 cores: they spend their time switching between each other and contending for locks, and throughput falls instead of rising; the PostgreSQL wiki suggests that active connections should be near twice the core count. Each connection can also use its own query memory, which was tuned for 200. The pods do not need 600 connections to the database. They need about as many as are doing work at the same moment, and something in between to share them.',
        vi: 'Lỗi biến mất, còn vấn đề thì dời chỗ. PostgreSQL chạy một tiến trình cho mỗi kết nối, và không có gì phía trước xếp hàng công việc. Khi một đợt cao điểm sáng thứ Hai đẩy hàng trăm request chạy cùng lúc, hàng trăm tiến trình chạy cùng lúc trên 16 nhân: chúng tốn thời gian chuyển qua lại và tranh chấp khoá, và throughput giảm thay vì tăng; wiki của PostgreSQL gợi ý số kết nối đang hoạt động nên gần gấp đôi số nhân. Mỗi kết nối cũng có thể dùng bộ nhớ truy vấn riêng, vốn được tinh chỉnh cho 200. Các pod không cần 600 kết nối tới database. Chúng cần khoảng bằng số kết nối đang làm việc cùng lúc, và một thứ ở giữa để chia sẻ chúng.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'PgBouncer in transaction mode with a pool of about 40 server connections, and change the code to set the tenant inside each transaction: `BEGIN; SET LOCAL app.clinic_id = …; … COMMIT`.',
        vi: 'PgBouncer ở chế độ transaction với pool khoảng 40 kết nối server, và sửa code để đặt tenant bên trong mỗi transaction: `BEGIN; SET LOCAL app.clinic_id = …; … COMMIT`.',
      },
      why: {
        en: 'In transaction mode PgBouncer lends a server connection to a client only for the length of one transaction, then takes it back. 600 client connections share 40 server connections, and since a transaction takes 5 ms, a client rarely waits more than a few milliseconds for one. Postgres sees 40 connections, which suits 16 cores. The price is that nothing may outlive a transaction, because the next transaction from the same client can run on a different server connection, and PgBouncer does not reset a connection between transactions. A plain `SET` is session state, so it has to go. `SET LOCAL` (or `set_config(…, true)`) as the first statement inside the transaction travels with the transaction and is discarded at `COMMIT`, so every transaction carries its own clinic ID.',
        vi: 'Ở chế độ transaction, PgBouncer chỉ cho client mượn một kết nối server trong thời gian một transaction, rồi lấy lại. 600 kết nối client chia nhau 40 kết nối server, và vì một transaction chỉ mất 5 ms, client hiếm khi phải chờ quá vài mili giây. Postgres chỉ thấy 40 kết nối, hợp với 16 nhân. Cái giá là không gì được sống lâu hơn một transaction, vì transaction tiếp theo của cùng client có thể chạy trên một kết nối server khác, và PgBouncer không reset kết nối giữa các transaction. Một lệnh `SET` thường là trạng thái của session, nên phải bỏ. `SET LOCAL` (hoặc `set_config(…, true)`) đặt làm lệnh đầu tiên trong transaction sẽ đi cùng transaction và bị huỷ khi `COMMIT`, nên mỗi transaction mang theo đúng clinic ID của nó.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'PgBouncer in session mode, accepting up to 1,000 client connections and opening at most 190 server connections, so the code keeps working exactly as it is.',
        vi: 'PgBouncer ở chế độ session, nhận tới 1.000 kết nối client và mở tối đa 190 kết nối server, để code giữ nguyên mà vẫn chạy.',
      },
      why: {
        en: 'Session mode is the safe one for session state: a client keeps the same server connection for as long as it stays connected, so `SET` behaves exactly as before. That is also why it does not help here. On a normal day it is fine: 120 client connections each get a server connection. On Monday the pods open 600 and hold them all day, so the first 190 take the 190 server connections and keep them, idle or not. The other 410 queue inside PgBouncer, and after `query_wait_timeout` they are disconnected. Session pooling helps when clients connect and disconnect often; it cannot share a connection that a client never lets go of.',
        vi: 'Chế độ session an toàn với trạng thái session: client giữ cùng một kết nối server suốt thời gian còn kết nối, nên `SET` hoạt động y như trước. Đó cũng chính là lý do nó không giúp được ở đây. Ngày thường thì ổn: 120 kết nối client mỗi cái nhận một kết nối server. Sáng thứ Hai các pod mở 600 và giữ cả ngày, nên 190 client đầu tiên chiếm 190 kết nối server và giữ luôn, dù rảnh hay không. 410 client còn lại xếp hàng trong PgBouncer, và sau `query_wait_timeout` thì bị ngắt kết nối. Session pooling có ích khi client kết nối và ngắt kết nối thường xuyên; nó không chia sẻ được một kết nối mà client không bao giờ trả lại.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'PgBouncer in transaction mode with a pool of about 40 server connections, keeping the code as it is.',
        vi: 'PgBouncer ở chế độ transaction với pool khoảng 40 kết nối server, giữ nguyên code.',
      },
      why: {
        en: 'It fixes Monday morning and breaks tenant isolation. The request\'s `SET app.clinic_id` runs outside the transaction, so PgBouncer treats it as a transaction of its own: it runs on one server connection, which goes back to the pool with clinic 17 still set on it. The `BEGIN … COMMIT` that follows can be given a different server connection, one that still carries whichever clinic ID the last client set there. By default PgBouncer hands out the most recently released connection first, so under load the next transaction often lands right on another clinic\'s fresh `SET`. Row-level security then does exactly what it is told and returns another clinic\'s appointments. It works in testing, where one request at a time keeps landing on the same connection, and fails under real concurrency. PgBouncer\'s own docs list `SET` as never compatible with transaction pooling.',
        vi: 'Nó giải quyết sáng thứ Hai và phá vỡ việc cô lập dữ liệu. Lệnh `SET app.clinic_id` của request chạy bên ngoài transaction, nên PgBouncer coi nó là một transaction riêng: nó chạy trên một kết nối server, rồi kết nối đó quay về pool mà vẫn mang clinic 17. Khối `BEGIN … COMMIT` theo sau có thể được cấp một kết nối server khác, kết nối vẫn mang clinic ID mà client trước đó đã đặt. Mặc định PgBouncer cấp kết nối vừa được trả gần nhất trước, nên khi tải cao, transaction tiếp theo thường rơi đúng vào lệnh `SET` vừa chạy của phòng khám khác. Row-level security khi đó làm đúng như được bảo và trả về lịch hẹn của một phòng khám khác. Nó chạy ổn khi test, vì mỗi lúc chỉ có một request nên luôn rơi vào cùng một kết nối, và hỏng khi có đồng thời thật. Chính tài liệu PgBouncer ghi `SET` là không bao giờ tương thích với transaction pooling.',
      },
    },
  ],

  answer: 'B',

  takeaway: {
    en: `**A pooler separates client connections from server connections.** Clients can hold hundreds of connections open; the database only needs as many as are doing work at the same moment.

- **Session mode:** a server connection belongs to a client until it disconnects. Safe for any session feature, but it only shares connections between clients that come and go.
- **Transaction mode:** a server connection belongs to a client for one transaction. It shares connections well, but **nothing may outlive a transaction**: no plain \`SET\`, session advisory locks, \`LISTEN\`, \`WITH HOLD\` cursors or temp tables that outlive the transaction. Protocol-level prepared statements work in recent PgBouncer versions when \`max_prepared_statements\` is set.
- **Put per-request settings inside the transaction** with \`SET LOCAL\` or \`set_config(name, value, true)\`. That is also the right shape for row-level security keyed on a setting.
- **Size the server pool from the database's cores**, not from the number of clients: the PostgreSQL wiki suggests starting near \`(cores × 2) + spindles\` active connections.
- Clients that cannot get a server connection wait in PgBouncer's queue, and are disconnected after \`query_wait_timeout\`. Watch the queue, not just the error rate.`,
    vi: `**Một pooler tách kết nối client khỏi kết nối server.** Client có thể giữ hàng trăm kết nối mở; database chỉ cần bằng số kết nối đang làm việc cùng lúc.

- **Chế độ session:** một kết nối server thuộc về client cho tới khi nó ngắt kết nối. An toàn với mọi tính năng của session, nhưng chỉ chia sẻ được kết nối giữa các client đến rồi đi.
- **Chế độ transaction:** một kết nối server thuộc về client trong một transaction. Nó chia sẻ kết nối rất tốt, nhưng **không gì được sống lâu hơn một transaction**: không \`SET\` thường, advisory lock theo session, \`LISTEN\`, cursor \`WITH HOLD\` hay bảng tạm sống lâu hơn transaction. Prepared statement ở mức giao thức chạy được trên các bản PgBouncer gần đây khi đặt \`max_prepared_statements\`.
- **Đặt cấu hình theo request bên trong transaction** bằng \`SET LOCAL\` hoặc \`set_config(name, value, true)\`. Đó cũng là cách đúng cho row-level security dựa trên một setting.
- **Định cỡ pool server theo số nhân của database**, không theo số client: wiki của PostgreSQL gợi ý bắt đầu gần \`(số nhân × 2) + số đĩa\` kết nối đang hoạt động.
- Client không lấy được kết nối server sẽ chờ trong hàng đợi của PgBouncer, và bị ngắt sau \`query_wait_timeout\`. Hãy theo dõi hàng đợi, không chỉ tỉ lệ lỗi.`,
  },

  sources: [
    { title: 'PgBouncer: Features (pooling modes; what transaction pooling does not support)', url: 'https://www.pgbouncer.org/features.html' },
    { title: 'PgBouncer: Configuration (pool_mode, default_pool_size, query_wait_timeout, server_reset_query)', url: 'https://www.pgbouncer.org/config.html' },
    { title: 'PostgreSQL documentation: SET (SESSION vs LOCAL)', url: 'https://www.postgresql.org/docs/current/sql-set.html' },
    { title: 'PostgreSQL documentation: Row Security Policies', url: 'https://www.postgresql.org/docs/current/ddl-rowsecurity.html' },
    { title: 'PostgreSQL wiki: Number Of Database Connections', url: 'https://wiki.postgresql.org/wiki/Number_Of_Database_Connections' },
  ],

  simulation,
};
