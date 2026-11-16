"""对外路由前缀的**单点定义**。

所有后端接口（含账号）都只挂 :data:`RKB_PREFIX` 一条前缀，nginx 也只反代它。

## 纪律

不要在别处再写第二份前缀字面量：nginx、前端 ``.env``、verify 脚本各自持有一份
「配置态」的副本是不可避免的（它们在不同的运行时里），但**后端代码**里只能有这一处。
"""

#: 对外契约前缀（nginx 只暴露它）。外部集成方请使用这个前缀。
#: Shared prefix for the service API.
RKB_PREFIX = '/api/knowledge-service/v1'

#: 本地账号登录：``status/login/logout/me/password``。
#: 与其它领域共用 RKB_PREFIX；必须在 register_rkb_api 之前注册
#: （kb_api 兜底路由会吃掉同前缀的晚注册路径）。
AUTH_PREFIX = f'{RKB_PREFIX}/auth'
