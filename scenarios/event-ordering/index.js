import * as simulation from './sim.js';

export default {
  category: 'queue',
  topic: { en: 'Event ordering', vi: 'Thứ tự sự kiện' },
  title: {
    en: 'Out for delivery, after delivered',
    vi: 'Đang giao, sau khi đã giao',
  },

  scenario: {
    en: `You run parcel tracking for an online store. A delivery carrier sends a webhook for every scan of a parcel:

\`\`\`
1 label_created   2 at_depot   3 out_for_delivery   4 delivered
\`\`\`

Your intake API puts each webhook on a queue. Twelve workers consume it in parallel; each one updates the parcel's status in Postgres and, when the status changes, sends the shopper a push notification.

The complaint: shoppers get **"Your parcel is out for delivery"** a few minutes after **"Your parcel was delivered"**, and the tracking page goes back to "Out for delivery". It happens to roughly **1 parcel in 200**.

What you find when you dig in:
- Drivers' handheld scanners work offline in basements and lifts. When they reconnect, they upload the stored scans in a burst, and the carrier sends those webhooks **at the same moment, in parallel**.
- The carrier's docs say a failed webhook is **retried with backoff for up to a day**, and deliveries are **not guaranteed to be in order**. Duplicates happen.
- When a worker fails mid-message (a database timeout, a deploy), the message comes back to the queue later, after newer ones.
- Every event carries \`parcel_id\`, \`seq\` (assigned by the carrier, increasing with every scan of that parcel) and \`scanned_at\` (the scanner's own clock, which can be minutes off).

Constraints:
- At peak the queue receives about **3,000 events a second**. One worker handles about 400.
- The status shown and the notifications sent must **never go backwards**. Late scans still belong in the parcel's history.
- Notifications should go out within seconds of the scan reaching you.`,
    vi: `Bạn phụ trách theo dõi đơn hàng cho một cửa hàng online. Hãng vận chuyển gửi một webhook cho mỗi lần quét kiện hàng:

\`\`\`
1 label_created   2 at_depot   3 out_for_delivery   4 delivered
\`\`\`

API tiếp nhận của bạn đưa mỗi webhook vào một queue. Mười hai worker tiêu thụ song song; mỗi worker cập nhật trạng thái kiện hàng trong Postgres và, khi trạng thái thay đổi, gửi push notification cho người mua.

Lời phàn nàn: người mua nhận **"Kiện hàng đang được giao"** vài phút sau **"Kiện hàng đã giao thành công"**, và trang theo dõi quay lại "Đang giao". Chuyện này xảy ra với khoảng **1 trên 200 kiện hàng**.

Những gì bạn tìm thấy khi đào sâu:
- Máy quét cầm tay của tài xế hoạt động offline trong tầng hầm và thang máy. Khi có mạng lại, chúng tải lên các lần quét đã lưu thành một loạt, và hãng vận chuyển gửi các webhook đó **cùng lúc, song song**.
- Tài liệu của hãng nói webhook thất bại sẽ được **gửi lại với backoff trong tối đa một ngày**, và việc gửi **không đảm bảo đúng thứ tự**. Có thể bị trùng.
- Khi một worker lỗi giữa chừng (database timeout, deploy), message quay lại queue muộn hơn, sau những message mới hơn.
- Mỗi sự kiện mang \`parcel_id\`, \`seq\` (do hãng gán, tăng dần với mỗi lần quét kiện hàng đó) và \`scanned_at\` (theo đồng hồ của chính máy quét, có thể lệch vài phút).

Ràng buộc:
- Lúc cao điểm queue nhận khoảng **3.000 sự kiện mỗi giây**. Một worker xử lý được khoảng 400.
- Trạng thái hiển thị và thông báo gửi đi **không bao giờ được đi lùi**. Các lần quét đến muộn vẫn phải nằm trong lịch sử của kiện hàng.
- Thông báo phải được gửi trong vài giây kể từ khi lần quét tới chỗ bạn.`,
  },

  question: {
    en: 'What do you change so a parcel\'s status never goes backwards?',
    vi: 'Bạn thay đổi gì để trạng thái kiện hàng không bao giờ đi lùi?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Run a single worker, so events are applied one at a time in the order they sit in the queue.',
        vi: 'Chạy một worker duy nhất, để các sự kiện được áp dụng lần lượt theo đúng thứ tự trong queue.',
      },
      why: {
        en: 'It removes the race between workers, but one worker handles about 400 events a second against 3,000 at peak, so the queue grows by thousands of events every second and notifications arrive hours late. And it only keeps the order events reached the queue in, which is already wrong: the carrier sends a burst of scans in parallel and retries failed ones much later, so "delivered" can be first in line. A single consumer is fine for low volume when the producer itself sends in order.',
        vi: 'Nó loại bỏ cuộc đua giữa các worker, nhưng một worker xử lý khoảng 400 sự kiện mỗi giây so với 3.000 lúc cao điểm, nên queue dồn thêm hàng nghìn sự kiện mỗi giây và thông báo tới trễ hàng giờ. Và nó chỉ giữ được thứ tự sự kiện đi vào queue, vốn đã sai: hãng vận chuyển gửi một loạt lần quét song song và gửi lại các webhook lỗi muộn hơn nhiều, nên "đã giao" có thể đứng đầu hàng. Một consumer duy nhất ổn khi lưu lượng thấp và chính bên gửi đã gửi đúng thứ tự.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Partition the queue by parcel: a FIFO queue with `parcel_id` as the message group (or a Kafka topic keyed by `parcel_id`), so each parcel\'s events are consumed one at a time, in order.',
        vi: 'Phân vùng queue theo kiện hàng: một FIFO queue với `parcel_id` làm message group (hoặc một Kafka topic dùng `parcel_id` làm key), để sự kiện của mỗi kiện hàng được tiêu thụ lần lượt, đúng thứ tự.',
      },
      why: {
        en: 'This is the right tool for the ordering problems inside your system: workers can no longer race on one parcel, and a failed message blocks its group instead of being overtaken. Thousands of parcels still process in parallel, so throughput is fine. But "in order" means the order events entered the queue, and the order was already lost before that. The carrier delivers a burst of scans in parallel, and a retried webhook can arrive an hour after the scans that followed it. FIFO faithfully preserves the wrong order. It is worth having alongside a fix at the point of applying an event, not instead of one.',
        vi: 'Đây là công cụ đúng cho các vấn đề thứ tự bên trong hệ thống của bạn: các worker không còn đua nhau trên một kiện hàng, và một message lỗi chặn cả nhóm của nó thay vì bị vượt mặt. Hàng nghìn kiện hàng vẫn được xử lý song song, nên thông lượng ổn. Nhưng "đúng thứ tự" nghĩa là thứ tự sự kiện đi vào queue, và thứ tự đã mất từ trước đó. Hãng vận chuyển gửi một loạt lần quét song song, và một webhook được gửi lại có thể tới sau những lần quét kế tiếp cả tiếng đồng hồ. FIFO giữ nguyên một thứ tự sai một cách trung thành. Nó đáng có bên cạnh một cách sửa ở chỗ áp dụng sự kiện, chứ không thay thế được.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Add a reorder buffer: hold every event for 30 seconds, then apply the buffered events for each parcel in `scanned_at` order.',
        vi: 'Thêm một bộ đệm sắp xếp lại: giữ mọi sự kiện 30 giây, rồi áp dụng các sự kiện đang đệm của mỗi kiện hàng theo thứ tự `scanned_at`.',
      },
      why: {
        en: 'It fixes the burst uploads, where all the scans arrive within a second and come from one scanner\'s clock. Everything else gets through. A webhook retried 20 minutes late misses the 30-second window and is applied after newer scans. Scans from different devices, a depot scanner and a driver\'s scanner, are ordered by two clocks that can be minutes apart. And every notification now waits 30 seconds. A longer window delays everyone more and still has an edge. Timestamps from devices you do not control are a weak ordering key.',
        vi: 'Nó sửa được các loạt tải lên dồn dập, khi mọi lần quét tới trong vòng một giây và đến từ đồng hồ của cùng một máy quét. Mọi thứ khác vẫn lọt qua. Một webhook được gửi lại muộn 20 phút lỡ cửa sổ 30 giây và bị áp dụng sau những lần quét mới hơn. Các lần quét từ những thiết bị khác nhau, máy quét ở kho và máy của tài xế, được sắp theo hai đồng hồ có thể lệch nhau vài phút. Và mọi thông báo giờ phải chờ 30 giây. Cửa sổ dài hơn làm mọi người chờ lâu hơn và vẫn có điểm mù. Mốc thời gian từ thiết bị bạn không kiểm soát là một khoá sắp xếp yếu.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Make the write check the order: store the last applied `seq` on the parcel and update with `... WHERE parcel_id = $1 AND last_seq < $2`. A late or duplicate event is added to the history but does not change the status or send a notification.',
        vi: 'Để thao tác ghi tự kiểm tra thứ tự: lưu `seq` cuối cùng đã áp dụng trên kiện hàng và cập nhật bằng `... WHERE parcel_id = $1 AND last_seq < $2`. Một sự kiện đến muộn hoặc bị trùng được thêm vào lịch sử nhưng không đổi trạng thái hay gửi thông báo.',
      },
      why: {
        en: 'It does not matter how the event got out of order: in the carrier\'s parallel delivery, in a retry a day later, in a race between your workers or in a redelivery. When "out_for_delivery" (seq 3) arrives after "delivered" (seq 4), the condition `last_seq < 3` is false, so the status stays Delivered and no notification goes out. The scan is still recorded in the history. Duplicates fall out the same way. The check is one atomic conditional update in the database, so all twelve workers keep running in parallel with no added delay. It works because the carrier gives you an ordering key it controls. If it did not, you would need one, such as a version from the source system. Partitioning by parcel is still worth adding to cut wasted work, but this is the part that makes the status correct.',
        vi: 'Không quan trọng sự kiện bị đảo thứ tự ở đâu: trong lần gửi song song của hãng, trong một lần gửi lại sau một ngày, trong cuộc đua giữa các worker hay trong một lần giao lại. Khi "out_for_delivery" (seq 3) tới sau "delivered" (seq 4), điều kiện `last_seq < 3` sai, nên trạng thái vẫn là Đã giao và không thông báo nào được gửi. Lần quét đó vẫn được ghi vào lịch sử. Sự kiện trùng cũng bị loại theo cách đó. Phép kiểm tra là một lệnh cập nhật có điều kiện, nguyên tử, trong database, nên cả mười hai worker vẫn chạy song song và không thêm độ trễ nào. Nó hoạt động vì hãng vận chuyển cho bạn một khoá thứ tự do họ kiểm soát. Nếu không có, bạn cần một khoá như vậy, chẳng hạn một version từ hệ thống nguồn. Phân vùng theo kiện hàng vẫn đáng thêm để giảm việc thừa, nhưng đây mới là phần làm trạng thái đúng.',
      },
    },
  ],

  answer: 'D',

  takeaway: {
    en: `Order is lost in more places than the queue: in the producer's parallel or retried deliveries, between your consumers, and on redelivery. So enforce it where the event is applied.

- Carry an **ordering key from the source** (a per-entity sequence or version) and make the write conditional on it. Late and duplicate events become harmless.
- **Partitioning by key** (a FIFO message group, a Kafka key) keeps one entity's events in queue order and stops consumers racing. Useful, but it can only preserve the order events arrived in.
- **A single consumer** gives up throughput for an order that may already be wrong.
- **Timestamps from many clocks**, and buffers that wait for stragglers, trade latency for a guarantee they cannot keep.`,
    vi: `Thứ tự bị mất ở nhiều chỗ hơn chỉ queue: trong các lần gửi song song hoặc gửi lại của bên phát, giữa các consumer của bạn, và khi giao lại. Vì vậy hãy bảo đảm thứ tự ở chỗ áp dụng sự kiện.

- Mang theo **một khoá thứ tự từ nguồn** (sequence hoặc version theo từng thực thể) và để thao tác ghi phụ thuộc vào nó. Sự kiện đến muộn và trùng lặp trở nên vô hại.
- **Phân vùng theo khoá** (message group của FIFO, key của Kafka) giữ sự kiện của một thực thể theo thứ tự trong queue và ngăn consumer đua nhau. Hữu ích, nhưng nó chỉ giữ được thứ tự lúc sự kiện tới.
- **Một consumer duy nhất** hy sinh thông lượng để đổi lấy một thứ tự có thể đã sai.
- **Mốc thời gian từ nhiều đồng hồ**, và các bộ đệm chờ sự kiện tới muộn, đổi độ trễ lấy một sự đảm bảo mà chúng không giữ được.`,
  },

  sources: [
    { title: 'Stripe documentation: Webhooks, event ordering and automatic retries', url: 'https://docs.stripe.com/webhooks' },
    { title: 'RabbitMQ documentation: Broker semantics, message ordering', url: 'https://www.rabbitmq.com/docs/semantics' },
    { title: 'Amazon SQS documentation: Using the message group ID with FIFO queues', url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagegroupid-property.html' },
    { title: 'Apache Kafka: Introduction (keys, partitions and ordering)', url: 'https://kafka.apache.org/intro' },
  ],

  simulation,
};
