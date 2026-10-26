import * as simulation from './sim.js';

export default {
  category: 'reliability',
  topic: { en: 'Webhook retries', vi: 'Webhook retry' },
  title: {
    en: 'One order, two photo books',
    vi: 'Một đơn hàng, hai cuốn photobook',
  },

  scenario: {
    en: `You run a small shop that prints **photo books** on demand. Customers pay with Stripe Checkout. When a payment completes, Stripe sends a \`checkout.session.completed\` event to your webhook endpoint, and that one HTTP request does all the work:

\`\`\`
POST /webhooks/stripe
  1  verify Stripe's signature
  2  mark the order paid                    Postgres
  3  send the book to the print partner     ~2 s, up to 15 s in December
  4  render the invoice PDF and email it
  5  reply 200
\`\`\`

December went badly:
- The print partner slowed down under holiday load. Requests ran past the point where Stripe stops waiting, so Stripe counted them as failed and **sent the same event again** later. The retry ran all five steps again: **dozens of customers received two books**, and you paid the partner for both.
- A few orders were doubled on days when the printer was fast. Stripe's docs say an endpoint can receive the **same event more than once**, and yours did.

Constraints:
- **Every paid order is printed exactly once.** A lost order is the worst outcome: someone paid and nothing ever ships, and nobody notices until they complain.
- The print partner's API has **no idempotency key**. Every call is a new job, and an accepted job cannot be cancelled.
- The partner can be slow for minutes at a time. You cannot make it faster.
- Your service runs in containers that deploys and autoscaling **stop several times a day, at any moment**, including mid-request.
- A book that goes to print a minute later is fine. Nobody waits on this request: the customer has already seen Stripe's success page.
- You already run Postgres. You would rather not add a new system unless you have to.`,
    vi: `Bạn điều hành một cửa hàng nhỏ in **photobook** theo yêu cầu. Khách thanh toán qua Stripe Checkout. Khi một giao dịch hoàn tất, Stripe gửi sự kiện \`checkout.session.completed\` tới webhook endpoint của bạn, và một HTTP request đó làm toàn bộ công việc:

\`\`\`
POST /webhooks/stripe
  1  xác minh chữ ký của Stripe
  2  đánh dấu đơn hàng đã thanh toán        Postgres
  3  gửi cuốn sách sang đối tác in          ~2 giây, tới 15 giây vào tháng 12
  4  tạo hoá đơn PDF và gửi email
  5  trả về 200
\`\`\`

Tháng 12 diễn ra tệ:
- Đối tác in chậm lại vì tải mùa lễ. Request chạy quá thời điểm Stripe ngừng chờ, nên Stripe coi là thất bại và **gửi lại cùng sự kiện đó** sau đó. Lần retry chạy lại cả năm bước: **hàng chục khách nhận hai cuốn sách**, và bạn trả tiền in cho cả hai.
- Vài đơn bị nhân đôi cả vào những ngày máy in chạy nhanh. Tài liệu của Stripe nói một endpoint có thể nhận **cùng một sự kiện nhiều hơn một lần**, và endpoint của bạn đã nhận như vậy.

Ràng buộc:
- **Mỗi đơn đã thanh toán được in đúng một lần.** Mất đơn là kết cục tệ nhất: khách đã trả tiền mà không có gì được giao, và không ai biết cho tới khi họ khiếu nại.
- API của đối tác in **không có idempotency key**. Mỗi lời gọi là một job mới, và job đã được nhận thì không huỷ được.
- Đối tác có thể chậm liên tục trong nhiều phút. Bạn không làm nó nhanh hơn được.
- Dịch vụ của bạn chạy trong các container mà deploy và autoscaling **dừng nhiều lần mỗi ngày, vào bất kỳ lúc nào**, kể cả giữa một request.
- Sách được gửi in trễ một phút cũng không sao. Không ai chờ request này: khách đã thấy trang thanh toán thành công của Stripe.
- Bạn đã có Postgres. Bạn không muốn thêm hệ thống mới nếu không thật cần thiết.`,
  },

  question: {
    en: 'How do you rebuild the webhook handler?',
    vi: 'Bạn xây lại webhook handler thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Make the request fast enough: run the invoice and email in parallel with the print call, and give the print call a 5-second timeout so the endpoint always answers before Stripe gives up.',
        vi: 'Làm request đủ nhanh: chạy hoá đơn và email song song với lời gọi in, và đặt timeout 5 giây cho lời gọi in để endpoint luôn trả lời trước khi Stripe bỏ cuộc.',
      },
      why: {
        en: 'Running the side work in parallel shortens a good day, but the slow step is the printer, and a client-side timeout only stops **you** waiting. The partner has already accepted the job and prints it anyway. Your handler now reports a failure, Stripe retries, and the retry sends a second job: a slow printer still produces two books, through a 500 instead of a timeout. It also does nothing about an event Stripe delivers twice. Timeouts on outgoing calls are worth having, but they cannot tell you whether a job that has no idempotency key happened.',
        vi: 'Chạy song song phần việc phụ giúp ngày bình thường nhanh hơn, nhưng bước chậm là máy in, và timeout phía client chỉ khiến **bạn** ngừng chờ. Đối tác đã nhận job và vẫn in. Handler của bạn giờ báo lỗi, Stripe retry, và lần retry gửi job thứ hai: máy in chậm vẫn sinh ra hai cuốn sách, chỉ là qua lỗi 500 thay vì timeout. Nó cũng không giải quyết được việc Stripe gửi một sự kiện hai lần. Timeout cho các lời gọi ra ngoài là nên có, nhưng nó không cho bạn biết một job không có idempotency key đã được thực hiện hay chưa.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Store, then reply, then work: verify the signature, insert the event into an `inbox` table keyed by the event ID (inserting a duplicate does nothing), and reply 200. Workers claim inbox rows with a short lease, do the order work, and mark the row done. A row whose lease runs out goes back to the pool.',
        vi: 'Lưu, rồi trả lời, rồi xử lý: xác minh chữ ký, insert sự kiện vào bảng `inbox` với khoá là event ID (insert trùng thì không làm gì), và trả về 200. Các worker nhận từng dòng inbox kèm một lease ngắn, xử lý đơn hàng, và đánh dấu dòng đã xong. Dòng nào hết lease thì quay lại hàng chờ.',
      },
      why: {
        en: 'The reply now depends only on a signature check and one insert, so a slow printer can no longer cause a retry. The event is **stored before Stripe hears 200**, so stopping a container at any moment loses nothing: a dead worker\'s lease runs out and another worker finishes the row. The primary key turns a second delivery of the same event into a no-op, and it runs on the Postgres you already have. One narrow gap remains that no design can close while the partner has no idempotency key: a worker that dies after the partner accepted the job but before it saved the job ID. Write "sending" on the order before the call and the job ID after it, so that rare case shows up for a person to check instead of being resent blindly.',
        vi: 'Phản hồi giờ chỉ phụ thuộc vào việc kiểm tra chữ ký và một lệnh insert, nên máy in chậm không còn gây ra retry. Sự kiện được **lưu trước khi Stripe nhận 200**, nên dừng container vào bất kỳ lúc nào cũng không mất gì: lease của worker đã chết hết hạn và một worker khác hoàn tất dòng đó. Primary key biến lần gửi thứ hai của cùng sự kiện thành không làm gì, và tất cả chạy trên Postgres bạn đã có. Còn một khe hở nhỏ mà không thiết kế nào đóng được khi đối tác không có idempotency key: worker chết sau khi đối tác đã nhận job nhưng trước khi lưu job ID. Hãy ghi "đang gửi" lên đơn hàng trước lời gọi và job ID sau lời gọi, để trường hợp hiếm đó hiện ra cho người kiểm tra thay vì bị gửi lại một cách mù quáng.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Reply 200 as soon as the signature checks out, then do the order work in the background in the same process (a promise the handler does not await).',
        vi: 'Trả về 200 ngay khi chữ ký hợp lệ, rồi xử lý đơn hàng ở background trong cùng tiến trình (một promise mà handler không await).',
      },
      why: {
        en: 'It fixes the timeouts: Stripe always gets its 200 within milliseconds, so the slow printer no longer causes retries. But the 200 tells Stripe the event is safe while it exists **only in one container\'s memory**. When a deploy stops that container mid-work, the order is gone and Stripe has no reason to send it again: a paid order that never prints, with nothing in any table to find it by. And with no record of event IDs, a second delivery is processed twice. Replying fast is half of the answer; the other half is storing the event durably before you reply.',
        vi: 'Nó giải quyết được timeout: Stripe luôn nhận 200 trong vài mili giây, nên máy in chậm không còn gây ra retry. Nhưng 200 nói với Stripe rằng sự kiện đã an toàn trong khi nó chỉ tồn tại **trong bộ nhớ của một container**. Khi một lần deploy dừng container đó giữa chừng, đơn hàng biến mất và Stripe không có lý do gì để gửi lại: một đơn đã thanh toán không bao giờ được in, và không bảng nào có dấu vết để tìm ra nó. Và vì không ghi lại event ID, lần gửi thứ hai bị xử lý hai lần. Trả lời nhanh mới là một nửa câu trả lời; nửa còn lại là lưu sự kiện một cách bền vững trước khi trả lời.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Make the handler idempotent: first thing in the request, insert the event ID into a `processed_events` table. If it is already there, reply 200 and stop. Otherwise do the work as today.',
        vi: 'Làm handler idempotent: việc đầu tiên trong request là insert event ID vào bảng `processed_events`. Nếu ID đã có, trả về 200 và dừng. Nếu chưa, xử lý như hiện tại.',
      },
      why: {
        en: 'It stops both kinds of duplicate: a retry or a second delivery finds the ID and stops, so nobody gets two books. But the ID is recorded **before** the work is done, so "seen" does not mean "done". If a container is stopped after the insert and before the print call, Stripe retries, the retry finds the ID, replies 200, and the order is never printed: the worst outcome, swapped in for the one you had. The endpoint is also still as slow as the printer, so every slow spell turns into a wave of timeouts and retries. Checking the event ID is right; it belongs next to the record that the work finished, not in front of the work.',
        vi: 'Nó chặn được cả hai kiểu trùng lặp: một lần retry hay lần gửi thứ hai thấy ID và dừng, nên không ai nhận hai cuốn sách. Nhưng ID được ghi **trước khi** công việc xong, nên "đã thấy" không có nghĩa là "đã xong". Nếu container bị dừng sau lệnh insert và trước lời gọi in, Stripe retry, lần retry thấy ID, trả về 200, và đơn hàng không bao giờ được in: kết cục tệ nhất, thay cho kết cục bạn đang gặp. Endpoint cũng vẫn chậm như máy in, nên mỗi đợt chậm lại thành một làn sóng timeout và retry. Kiểm tra event ID là đúng; nó nên nằm cạnh bản ghi rằng công việc đã xong, chứ không phải đứng trước công việc.',
      },
    },
  ],

  answer: 'B',

  takeaway: {
    en: `A webhook endpoint should **receive, not process**: verify, store durably, reply. A 200 tells the sender to stop retrying, so only send it for what you have already stored.

- **Store before you acknowledge.** Work kept only in memory disappears with the container, and the sender will not send it again.
- **Deduplicate on the event ID** with a unique key, and mark an event done only when its work is done. "Seen" and "done" are different states.
- Delivery is **at-least-once** at every hop: the provider retries, and queues such as SQS standard queues redeliver too. Exactly-once *effects* come from idempotent processing, not from the transport.
- When a downstream call cannot be made idempotent, **record the intent before the call and the result after it**, so the rare uncertain case is visible instead of silently repeated.
- An external queue instead of a Postgres inbox works the same way. It takes load off the database at high volume, at the cost of one more system to run, and its consumers still need to deduplicate.
- Events can also arrive **out of order**. That is a separate problem, covered in scenario 05.`,
    vi: `Một webhook endpoint nên **nhận, chứ không xử lý**: xác minh, lưu bền vững, trả lời. Mã 200 bảo bên gửi ngừng retry, nên chỉ gửi nó cho những gì bạn đã lưu.

- **Lưu trước khi xác nhận.** Công việc chỉ nằm trong bộ nhớ sẽ biến mất cùng container, và bên gửi sẽ không gửi lại.
- **Khử trùng lặp theo event ID** bằng một khoá unique, và chỉ đánh dấu sự kiện là xong khi công việc đã xong. "Đã thấy" và "đã xong" là hai trạng thái khác nhau.
- Việc gửi là **at-least-once** ở mọi chặng: nhà cung cấp retry, và các queue như SQS standard cũng gửi lại. Hiệu ứng *đúng một lần* đến từ việc xử lý idempotent, không phải từ tầng truyền tải.
- Khi một lời gọi phía sau không thể làm idempotent, **ghi ý định trước lời gọi và kết quả sau lời gọi**, để trường hợp hiếm không chắc chắn hiện ra thay vì bị lặp lại âm thầm.
- Dùng queue bên ngoài thay cho inbox trên Postgres cũng hoạt động giống vậy. Nó giảm tải cho database khi lưu lượng lớn, đổi lại phải vận hành thêm một hệ thống, và consumer của nó vẫn phải khử trùng lặp.
- Sự kiện cũng có thể đến **sai thứ tự**. Đó là một vấn đề riêng, có trong tình huống 05.`,
  },

  sources: [
    { title: 'Stripe documentation: Receive Stripe events in your webhook endpoint (quick 2xx, duplicate events, retries)', url: 'https://docs.stripe.com/webhooks' },
    { title: 'Stripe documentation: Fulfill orders (fulfillment can run more than once, even concurrently)', url: 'https://docs.stripe.com/checkout/fulfillment' },
    { title: 'GitHub Docs: Best practices for using webhooks (respond quickly, process asynchronously)', url: 'https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks' },
    { title: 'microservices.io: Pattern: Idempotent Consumer', url: 'https://microservices.io/patterns/communication-style/idempotent-consumer.html' },
    { title: 'Amazon SQS Developer Guide: At-least-once delivery', url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html' },
  ],

  simulation,
};
