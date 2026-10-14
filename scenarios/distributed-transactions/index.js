import * as simulation from './sim.js';

export default {
  category: 'microservices',
  topic: { en: 'Distributed transactions', vi: 'Giao dịch phân tán' },
  title: {
    en: 'A flight, a hotel and one card',
    vi: 'Một chuyến bay, một khách sạn và một thẻ',
  },

  scenario: {
    en: `You run the booking service of a travel app that sells **flight + hotel packages**. One booking touches three systems you do not own:

\`\`\`
Airline API    hold seat (expires in 15 min) · issue ticket · release hold
Hotel API      hold room (expires in 15 min) · confirm · release hold
Payments API   authorize card · capture · cancel authorization · refund
\`\`\`

Today's code opens a database transaction for the booking row, calls the three APIs one after another, and runs \`ROLLBACK\` if anything throws. Last month went badly:
- When the hotel had no room, the customer was told "booking failed", yet **a seat stayed held and $1,240 stayed authorized on their card** for days.
- A deploy restarted the service mid-booking. Nobody knew which calls had already gone out.
- The airline call timed out, the code retried, and the customer got **two tickets**.

Constraints:
- The three partners are plain HTTP APIs. None of them can take part in a distributed transaction (no prepare or commit across systems).
- **Issuing a ticket is final.** Fares are non-refundable once ticketed. Holds and authorizations can be released.
- The booking service is redeployed several times a day and must pick up an interrupted booking where it left off.
- Every partner accepts an **idempotency key**: a retry with the same key returns the first result instead of doing the work twice.
- Support must be able to see exactly which step any booking is at.`,
    vi: `Bạn phụ trách dịch vụ đặt chỗ của một ứng dụng du lịch bán **gói vé máy bay + khách sạn**. Một lần đặt chạm tới ba hệ thống không thuộc về bạn:

\`\`\`
Airline API    giữ ghế (hết hạn sau 15 phút) · xuất vé · huỷ giữ chỗ
Hotel API      giữ phòng (hết hạn sau 15 phút) · xác nhận · huỷ giữ chỗ
Payments API   cấp phép thẻ · thu tiền · huỷ cấp phép · hoàn tiền
\`\`\`

Code hiện tại mở một transaction database cho dòng đặt chỗ, gọi lần lượt ba API, và chạy \`ROLLBACK\` nếu có lỗi. Tháng trước diễn ra tệ:
- Khi khách sạn hết phòng, khách được báo "đặt chỗ thất bại", nhưng **một ghế vẫn bị giữ và 1.240 đô vẫn bị cấp phép trên thẻ của họ** suốt nhiều ngày.
- Một lần deploy khởi động lại dịch vụ giữa lúc đang đặt. Không ai biết lời gọi nào đã được gửi đi.
- Lời gọi tới hãng bay bị timeout, code thử lại, và khách nhận **hai vé**.

Ràng buộc:
- Ba đối tác là các HTTP API thông thường. Không bên nào tham gia được giao dịch phân tán (không có prepare hay commit xuyên hệ thống).
- **Xuất vé là không thể đảo ngược.** Giá vé không hoàn lại sau khi đã xuất. Giữ chỗ và cấp phép thì có thể huỷ.
- Dịch vụ đặt chỗ được deploy nhiều lần mỗi ngày và phải tiếp tục một lần đặt bị gián đoạn từ đúng chỗ đã dừng.
- Mọi đối tác đều nhận **idempotency key**: thử lại với cùng key sẽ trả về kết quả lần đầu thay vì làm lại.
- Bộ phận hỗ trợ phải thấy chính xác mỗi lần đặt đang ở bước nào.`,
  },

  question: {
    en: 'How do you make a booking all-or-nothing?',
    vi: 'Bạn làm thế nào để một lần đặt chỗ hoặc thành công trọn vẹn, hoặc không có gì xảy ra?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Keep the database transaction, but make it stricter: run the whole booking at `SERIALIZABLE` isolation and roll back on any error.',
        vi: 'Giữ transaction database, nhưng chặt chẽ hơn: chạy cả lần đặt ở mức cô lập `SERIALIZABLE` và rollback khi có bất kỳ lỗi nào.',
      },
      why: {
        en: 'A database transaction can only undo changes in that database. `ROLLBACK` removes your booking row; it cannot un-hold a seat at the airline or cancel an authorization at the payment provider, because those happened in other companies\' systems the moment the HTTP call returned. Stricter isolation changes how concurrent transactions in your own database see each other, which is not the problem. The orphaned holds, the lingering $1,240 authorization (card authorizations usually last about 7 days) and the double ticket all stay.',
        vi: 'Một transaction database chỉ hoàn tác được thay đổi trong chính database đó. `ROLLBACK` xoá dòng đặt chỗ của bạn; nó không thể huỷ giữ ghế ở hãng bay hay huỷ cấp phép ở bên thanh toán, vì những việc đó đã xảy ra trong hệ thống của công ty khác ngay khi lời gọi HTTP trả về. Mức cô lập chặt hơn chỉ thay đổi cách các transaction đồng thời trong database của bạn nhìn thấy nhau, vốn không phải vấn đề. Các giữ chỗ bị bỏ rơi, khoản cấp phép 1.240 đô còn treo (cấp phép thẻ thường kéo dài khoảng 7 ngày) và vé kép đều còn nguyên.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Two-phase commit: a coordinator asks the airline, hotel and payment provider to PREPARE, and commits on all of them only when all three have said yes.',
        vi: 'Two-phase commit: một coordinator yêu cầu hãng bay, khách sạn và bên thanh toán PREPARE, và chỉ commit trên cả ba khi cả ba đều đồng ý.',
      },
      why: {
        en: 'It would give true atomicity, if the participants supported it. They do not: two-phase commit needs every participant to implement prepare and commit and to hold its locks until the coordinator decides, and these partners expose plain HTTP endpoints. Even inside your own company, holding locks across services for the seconds or minutes a booking takes, with the coordinator as a single point that can leave everyone blocked if it crashes mid-protocol, is why two-phase commit is rarely used between microservices. It belongs between databases that support it, inside one trust boundary.',
        vi: 'Nó sẽ cho tính nguyên tử thật sự, nếu các bên tham gia hỗ trợ. Nhưng họ không hỗ trợ: two-phase commit đòi hỏi mọi bên phải cài đặt prepare và commit và giữ khoá cho tới khi coordinator quyết định, còn các đối tác này chỉ có endpoint HTTP thông thường. Ngay cả trong nội bộ công ty, việc giữ khoá xuyên dịch vụ suốt vài giây hay vài phút của một lần đặt, với coordinator là một điểm duy nhất có thể khiến mọi bên bị kẹt nếu nó sập giữa chừng, là lý do two-phase commit hiếm khi được dùng giữa các microservice. Nó thuộc về các database hỗ trợ nó, trong cùng một ranh giới tin cậy.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'A saga that saves its progress: run the steps from a workflow whose state is stored after every step. Holds and the card authorization first; issuing the ticket last. Each reversible step has an undo (release, cancel), and every call carries an idempotency key.',
        vi: 'Một saga lưu lại tiến độ: chạy các bước từ một workflow có trạng thái được lưu sau mỗi bước. Giữ chỗ và cấp phép thẻ trước; xuất vé sau cùng. Mỗi bước đảo ngược được có một thao tác hoàn tác (huỷ giữ chỗ, huỷ cấp phép), và mọi lời gọi đều mang idempotency key.',
      },
      why: {
        en: 'Each step is a local, committed action at one partner, and the saga makes the whole sequence end in one of two clean states. The order does the heavy lifting: hold seat, hold room, authorize card are all reversible, so if any of them fails the saga runs the undo for every earlier step (release room, release seat) and the customer is charged nothing. Issuing the ticket is the point of no return, so it comes only after everything reversible has succeeded. After it, the remaining steps (confirm room, capture payment) are retried until they succeed. Because the state is saved after every step, a redeploy resumes the booking at the right step, and support can read it. Because every call has an idempotency key, a timed-out call can be retried safely: the airline returns the ticket it already issued instead of issuing a second one.',
        vi: 'Mỗi bước là một hành động cục bộ đã commit tại một đối tác, và saga khiến cả chuỗi kết thúc ở một trong hai trạng thái sạch. Thứ tự làm phần việc chính: giữ ghế, giữ phòng, cấp phép thẻ đều đảo ngược được, nên nếu bất kỳ bước nào thất bại, saga chạy thao tác hoàn tác cho mọi bước trước đó (huỷ giữ phòng, huỷ giữ ghế) và khách không bị trừ đồng nào. Xuất vé là điểm không thể quay lại, nên nó chỉ đến sau khi mọi bước đảo ngược được đã thành công. Sau đó, các bước còn lại (xác nhận phòng, thu tiền) được thử lại cho tới khi thành công. Vì trạng thái được lưu sau mỗi bước, một lần deploy sẽ tiếp tục lần đặt ở đúng bước, và bộ phận hỗ trợ đọc được nó. Vì mọi lời gọi có idempotency key, một lời gọi bị timeout có thể thử lại an toàn: hãng bay trả về vé đã xuất thay vì xuất vé thứ hai.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Call the three partners and record what each one returned; a reconciliation job runs every night, compares the records with each partner, and cancels or refunds anything that does not match.',
        vi: 'Gọi ba đối tác và ghi lại kết quả từng bên trả về; một job đối soát chạy mỗi đêm, so sánh bản ghi với từng đối tác, và huỷ hoặc hoàn tiền bất cứ thứ gì không khớp.',
      },
      why: {
        en: 'Reconciliation is a good safety net, and every payments system should have one, but as the main mechanism it fixes things hours too late. When the hotel has no room, the customer spends the rest of the day with a held seat and money on their card. Worse, by the time the job runs, a ticket that was issued in the meantime cannot be undone at all. A nightly job also cannot resume a booking interrupted by a deploy at 2 p.m., and it does not prevent the double ticket, only finds it. Keep reconciliation as a backstop behind the saga, not instead of it.',
        vi: 'Đối soát là một lưới an toàn tốt, và mọi hệ thống thanh toán nên có, nhưng làm cơ chế chính thì nó sửa mọi thứ trễ hàng giờ. Khi khách sạn hết phòng, khách mang theo một ghế bị giữ và tiền bị treo trên thẻ suốt cả ngày. Tệ hơn, khi job chạy, một vé đã được xuất trong lúc đó thì không thể hoàn tác được nữa. Một job ban đêm cũng không tiếp tục được một lần đặt bị gián đoạn bởi deploy lúc 2 giờ chiều, và nó không ngăn được vé kép, chỉ tìm ra nó. Hãy giữ đối soát làm chốt chặn phía sau saga, chứ không thay thế saga.',
      },
    },
  ],

  answer: 'C',

  takeaway: {
    en: `Across services you cannot roll back; you can only **undo forward**. A saga is a sequence of local steps, each with a compensating action, that ends either fully done or fully undone.

- **Order the steps by reversibility:** compensable steps (holds, authorizations) first, the **pivot** (the step you cannot undo) once all of them have succeeded, then steps that can be retried until they succeed.
- **Persist the saga's state** after every step so a crash resumes instead of guessing, and so people can see where a booking stands.
- **Make every call idempotent** so retries after a timeout are safe.
- **Orchestration** (one workflow drives the steps, as here) is easiest to follow and debug. **Choreography** (services react to each other's events) avoids a central coordinator but spreads the flow across services.
- Two-phase commit needs participants that support it and blocks on its coordinator. Reconciliation is a backstop, not the mechanism.`,
    vi: `Xuyên dịch vụ thì bạn không thể rollback; bạn chỉ có thể **hoàn tác tiến lên**. Saga là một chuỗi bước cục bộ, mỗi bước có một thao tác bù trừ, kết thúc ở trạng thái hoặc hoàn tất trọn vẹn, hoặc được hoàn tác trọn vẹn.

- **Sắp xếp các bước theo khả năng đảo ngược:** các bước bù trừ được (giữ chỗ, cấp phép) trước, **điểm xoay** (bước không thể hoàn tác) khi tất cả chúng đã thành công, rồi đến các bước có thể thử lại cho tới khi thành công.
- **Lưu trạng thái của saga** sau mỗi bước để khi sập thì tiếp tục chứ không phải đoán, và để mọi người thấy lần đặt đang ở đâu.
- **Làm mọi lời gọi idempotent** để thử lại sau timeout là an toàn.
- **Orchestration** (một workflow điều khiển các bước, như ở đây) dễ theo dõi và debug nhất. **Choreography** (các dịch vụ phản ứng với sự kiện của nhau) tránh được coordinator trung tâm nhưng rải luồng xử lý ra nhiều dịch vụ.
- Two-phase commit cần các bên hỗ trợ nó và bị chặn bởi coordinator. Đối soát là chốt chặn phía sau, không phải cơ chế chính.`,
  },

  sources: [
    { title: 'Microsoft Azure Architecture Center: Saga design pattern (compensable, pivot and retryable transactions)', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/saga' },
    { title: 'Stripe API reference: Idempotent requests', url: 'https://docs.stripe.com/api/idempotent_requests' },
    { title: 'Stripe documentation: Place a hold on a payment method (authorize now, capture later)', url: 'https://docs.stripe.com/payments/place-a-hold-on-a-payment-method' },
  ],

  simulation,
};
