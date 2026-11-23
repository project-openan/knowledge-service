# ``graph_extract_v2_api`` 是 HTTP API 层文件，已归位到 ``graph/`` 包下
# （service 包只放 service）；这里保留包级别名，让既有调用方
# （含测试的 ``from graph.service import graph_extract_v2_api``）不必改 import 路径。
from graph import graph_extract_v2_api  # noqa: F401
