"""对外路由前缀的**单点定义**。

所有后端接口（含编排、图谱检索、账号）都只挂 :data:`RKB_PREFIX` 一条前缀，
nginx 也只反代它。

## 纪律

不要在别处再写第二份前缀字面量：nginx、前端 ``.env``、verify 脚本各自持有一份
「配置态」的副本是不可避免的（它们在不同的运行时里），但**后端代码**里只能有这一处。
"""

#: 对外契约前缀（nginx 只暴露它）。外部集成方请使用这个前缀。
RKB_PREFIX = '/api/knowledge-service/v1'

#: 图谱向量检索的对外路径（由 graph.api 随 kb router 注册）。
GRAPH_RETRIEVE_PATH = f'{RKB_PREFIX}/retrieval/graph'

#: 本地账号登录：``status/login/logout/me/password``。与其它领域共用 RKB_PREFIX。
AUTH_PREFIX = f'{RKB_PREFIX}/auth'
