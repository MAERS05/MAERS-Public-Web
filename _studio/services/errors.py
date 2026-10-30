"""错误边界：内部细节只写服务日志，API 返回稳定的公开错误消息。"""
import traceback
from .contracts import Response


def internal_error(error: Exception, operation: str, message: str = '操作失败，请查看本地服务日志') -> Response:
    print(f'  [ ERROR ] ❌ 操作失败 | Operation failed: {operation}')
    traceback.print_exception(type(error), error, error.__traceback__)
    return 500, {'error': message}
