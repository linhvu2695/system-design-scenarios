import * as simulation from './sim.js';

export default {
  category: 'microservices',
  topic: { en: 'API gateway', vi: 'API gateway' },
  title: {
    en: 'The app that knows too many addresses',
    vi: 'Ứng dụng biết quá nhiều địa chỉ',
  },

  scenario: {
    en: `You are on the platform team of a city parking app. The iOS and Android apps call five backend services directly, each on its own hostname:

\`\`\`
zones.parkapp.example      map, zones, prices            (Go)
sessions.parkapp.example   start/stop parking, receipts  (Kotlin)
accounts.parkapp.example   login, vehicles               (Node)
wallet.parkapp.example     top-ups, saved cards          (Kotlin)
help.parkapp.example       support chat                  (Node)
\`\`\`

Next month the billing team takes receipts out of the sessions service. \`GET /v1/sessions/{id}/receipt\` will be served by a new billing service. The app has called that path on \`sessions.parkapp.example\` since its first release.

Two more things came up in the planning meeting:
- Every service checks login tokens itself, with a different library per language. Last quarter the Go service accepted expired tokens for nine days before anyone noticed.
- The sessions team asks how long they must keep the receipt code after the move. Nobody can answer, because old app versions never fully go away.

Constraints:
- You cannot force an app update. About **one in five** weekly active users runs a version more than six months old.
- The five teams deploy independently, several times a day, and that has to stay true.
- Each screen talks to one service, in one or two calls. The app is not slow. The problem is that it knows where everything lives.
- The app does not pin TLS certificates.`,
    vi: `Bạn ở team platform của một ứng dụng gửi xe trong thành phố. App iOS và Android gọi thẳng tới năm service backend, mỗi service một hostname riêng:

\`\`\`
zones.parkapp.example      bản đồ, khu vực, giá           (Go)
sessions.parkapp.example   bắt đầu/kết thúc gửi xe, hoá đơn (Kotlin)
accounts.parkapp.example   đăng nhập, phương tiện         (Node)
wallet.parkapp.example     nạp tiền, thẻ đã lưu           (Kotlin)
help.parkapp.example       chat hỗ trợ                    (Node)
\`\`\`

Tháng sau team billing tách phần hoá đơn ra khỏi service sessions. \`GET /v1/sessions/{id}/receipt\` sẽ do một service billing mới phục vụ. App đã gọi đường dẫn đó trên \`sessions.parkapp.example\` từ bản phát hành đầu tiên.

Trong buổi họp lên kế hoạch còn nổi lên hai chuyện:
- Mỗi service tự kiểm tra token đăng nhập, mỗi ngôn ngữ một thư viện khác nhau. Quý trước service Go chấp nhận token đã hết hạn suốt chín ngày mà không ai phát hiện.
- Team sessions hỏi phải giữ code hoá đơn bao lâu sau khi chuyển. Không ai trả lời được, vì các bản app cũ không bao giờ biến mất hoàn toàn.

Ràng buộc:
- Bạn không thể ép người dùng cập nhật app. Khoảng **một phần năm** người dùng hoạt động hằng tuần đang chạy bản cũ hơn sáu tháng.
- Năm team deploy độc lập, nhiều lần mỗi ngày, và điều đó phải được giữ nguyên.
- Mỗi màn hình chỉ nói chuyện với một service, qua một hoặc hai lời gọi. App không chậm. Vấn đề là nó biết mọi thứ nằm ở đâu.
- App không pin chứng chỉ TLS.`,
  },

  question: {
    en: 'What do you put in place before receipts move?',
    vi: 'Bạn dựng gì trước khi phần hoá đơn được chuyển đi?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Ship remote config: at startup the app downloads a map from endpoint name to base URL, so the backend can repoint any endpoint without an app release.',
        vi: 'Phát hành remote config: khi khởi động, app tải về một bảng ánh xạ từ tên endpoint sang base URL, để backend trỏ lại bất kỳ endpoint nào mà không cần phát hành app.',
      },
      why: {
        en: 'It only helps app versions that contain it, and the first of those is the same release the receipt move needs. Everyone still on today\'s versions, including the one in five on versions older than six months, breaks the day sessions deletes its receipt code. Later moves go better, but the users who never update stay broken. It also leaves the token problem alone: five services, five ways of checking a token. And it moves routing into every phone instead of taking it out. Remote config is a good tool for feature flags. It is the wrong place to keep your service map.',
        vi: 'Nó chỉ có tác dụng với các bản app có chứa nó, và bản đầu tiên như thế chính là bản phát hành mà việc chuyển hoá đơn cần. Ai còn ở các bản hiện tại, kể cả một phần năm người dùng ở bản cũ hơn sáu tháng, sẽ hỏng vào ngày sessions xoá code hoá đơn. Những lần chuyển sau đỡ hơn, nhưng người không bao giờ cập nhật vẫn hỏng. Nó cũng không đụng tới chuyện token: năm service, năm cách kiểm tra token. Và nó đẩy việc định tuyến vào từng chiếc điện thoại thay vì kéo nó ra. Remote config rất hợp cho feature flag. Nó không phải chỗ để giữ bản đồ service của bạn.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Put an API gateway on `api.parkapp.example`: route by path to each service, check tokens and rate limits there, point the five old hostnames at it with host-based routes, and make the services reachable only through it.',
        vi: 'Đặt một API gateway ở `api.parkapp.example`: định tuyến theo đường dẫn tới từng service, kiểm tra token và rate limit tại đó, trỏ năm hostname cũ về nó bằng route theo host, và chỉ cho phép truy cập các service qua nó.',
      },
      why: {
        en: 'Installed apps keep calling `sessions.parkapp.example/v1/sessions/{id}/receipt`. DNS now sends that request to the gateway, so the receipt move is one route change: that path goes to billing. The sessions team can delete its receipt code the day billing is live, without waiting for anyone to update. New app versions call only `api.parkapp.example`, so later splits are also route changes. Token checks live in one place, owned by one team. The services still authenticate the gateway (mTLS or a private network), so nobody can go around it. Teams keep deploying on their own because the gateway holds routes and shared checks, not business logic. The costs are an extra network hop on every request, one more component that has to be highly available, and the discipline to keep business logic out of it. Under these constraints it is the only option that fixes both the installed apps and the token checks.',
        vi: 'Các app đã cài vẫn gọi `sessions.parkapp.example/v1/sessions/{id}/receipt`. Giờ DNS đưa request đó tới gateway, nên việc chuyển hoá đơn chỉ là đổi một route: đường dẫn đó đi tới billing. Team sessions có thể xoá code hoá đơn ngay ngày billing chạy, không cần đợi ai cập nhật. Các bản app mới chỉ gọi `api.parkapp.example`, nên những lần tách sau cũng chỉ là đổi route. Việc kiểm tra token nằm ở một chỗ, do một team sở hữu. Các service vẫn xác thực gateway (mTLS hoặc mạng nội bộ), nên không ai đi vòng qua được. Các team vẫn deploy độc lập vì gateway chỉ giữ route và các bước kiểm tra chung, không giữ business logic. Cái giá là thêm một chặng mạng cho mọi request, thêm một thành phần phải luôn sẵn sàng cao, và kỷ luật để không nhét business logic vào đó. Với các ràng buộc này, đây là phương án duy nhất sửa được cả các app đã cài lẫn chuyện kiểm tra token.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Merge the five services into one deployable behind one hostname, so the app has a single backend to talk to.',
        vi: 'Gộp năm service thành một bản deploy duy nhất sau một hostname, để app chỉ còn một backend để nói chuyện.',
      },
      why: {
        en: 'It does give the app one address and one place to check tokens. But it ends independent deploys, which the constraints rule out, and it is months of work for a problem that sits at the network edge, not in how the code is split. It does not even help the apps already installed: they still call five hostnames, so you would need something routing those to the merged service. That something is a gateway. You do not have to merge code to give clients one address.',
        vi: 'Nó đúng là cho app một địa chỉ và một chỗ kiểm tra token. Nhưng nó chấm dứt việc deploy độc lập, điều mà ràng buộc không cho phép, và tốn hàng tháng trời cho một vấn đề nằm ở rìa mạng chứ không nằm ở cách chia code. Nó thậm chí không giúp các app đã cài: chúng vẫn gọi năm hostname, nên bạn vẫn cần thứ gì đó định tuyến chúng về service đã gộp. Thứ đó chính là gateway. Bạn không cần gộp code mới cho client được một địa chỉ.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Adopt a service mesh with sidecar proxies, so every service gets mTLS, retries and traffic shifting.',
        vi: 'Dùng service mesh với sidecar proxy, để service nào cũng có mTLS, retry và chuyển dần lưu lượng.',
      },
      why: {
        en: 'A mesh manages traffic between services inside your cluster. The phones are not in the mesh. The sidecar next to sessions only sees requests that have already reached sessions, and nothing about the mesh changes which hostname the app calls. Meshes do come with an ingress gateway for traffic from outside, and once you set that up to route by path and check tokens, you have built option B. Pick a mesh when the pain is between services: mTLS, retries, canary releases.',
        vi: 'Mesh quản lý lưu lượng giữa các service bên trong cluster. Điện thoại không nằm trong mesh. Sidecar cạnh sessions chỉ thấy những request đã tới sessions, và mesh không thay đổi gì hostname mà app gọi. Mesh thường đi kèm một ingress gateway cho lưu lượng từ ngoài vào, và một khi bạn cấu hình nó để định tuyến theo đường dẫn và kiểm tra token, bạn đã dựng phương án B. Hãy chọn mesh khi chỗ đau nằm giữa các service: mTLS, retry, canary release.',
      },
    },
  ],

  answer: 'B',

  takeaway: {
    en: `A mobile app is a client you cannot redeploy. Whatever it calls on day one stays a public contract for years, so give it an address and paths you own, not a copy of your internal service map.

- An **API gateway** holds that contract: routing, token checks, rate limits and request logs at the edge, while services move and split behind it. Keep it thin, with no business logic.
- A **Backend for Frontend** is the next step when one client needs data from several services combined or reshaped per screen. It usually sits behind the gateway and belongs to the team that builds the app.
- Moving endpoints one route at a time behind a stable router is the **strangler fig** way to migrate.`,
    vi: `Ứng dụng di động là một client bạn không thể deploy lại. Thứ nó gọi từ ngày đầu sẽ là một hợp đồng công khai trong nhiều năm, nên hãy cho nó một địa chỉ và các đường dẫn do bạn làm chủ, chứ đừng đưa nó bản sao sơ đồ service nội bộ.

- **API gateway** giữ hợp đồng đó: định tuyến, kiểm tra token, rate limit và log request ở rìa, trong khi các service di chuyển và tách ra phía sau. Giữ nó mỏng, không có business logic.
- **Backend for Frontend** là bước tiếp theo khi một client cần gộp hoặc định hình lại dữ liệu từ nhiều service cho mỗi màn hình. Nó thường nằm sau gateway và thuộc về team làm app.
- Chuyển từng endpoint một, từng route một, phía sau một bộ định tuyến ổn định là cách di chuyển kiểu **strangler fig**.`,
  },

  sources: [
    { title: 'Microsoft Azure Architecture Center: Gateway Routing pattern', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-routing' },
    { title: 'Microsoft Azure Architecture Center: Gateway Offloading pattern', url: 'https://learn.microsoft.com/en-us/azure/architecture/patterns/gateway-offloading' },
    { title: 'Chris Richardson, microservices.io: API Gateway / Backends for Frontends', url: 'https://microservices.io/patterns/apigateway.html' },
    { title: 'Sam Newman: Backends For Frontends', url: 'https://samnewman.io/patterns/architectural/bff/' },
    { title: 'Martin Fowler: Strangler Fig', url: 'https://martinfowler.com/bliki/StranglerFigApplication.html' },
    { title: 'Istio: Ingress Gateways', url: 'https://istio.io/latest/docs/tasks/traffic-management/ingress/ingress-control/' },
  ],

  simulation,
};
