"""后端边界类型：JSON 载荷、HTTP 响应和 CMS 文件存储上下文。"""
from __future__ import annotations
from typing import Callable, TypedDict, Union

JsonValue = Union[None, bool, int, float, str, list['JsonValue'], dict[str, 'JsonValue']]
JsonObject = dict[str, JsonValue]
Query = dict[str, list[str]]
Response = tuple[int, JsonValue]
Validator = Callable[[JsonValue], None]
Handler = Callable[[Query, JsonValue, bytes | None], Response]


class CmsContext(TypedDict):
    DATA_DIR: str
    PROJECT_ROOT: str
    load_tree: Callable[[str], JsonObject]
    save_tree: Callable[[str, JsonObject], bool]
