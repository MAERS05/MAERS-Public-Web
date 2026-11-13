"""开源替换的非界面回归：源码模型和资源生命周期。"""
import subprocess
from .sandbox import SandboxTestCase
from .node_runtime import NodeTestCase, NODE_BIN
from .helpers import PROJECT_ROOT


class Test15_OpenComponents(SandboxTestCase, NodeTestCase):
    timeout = 60

    def test_component_adapters_data_and_lifetimes(self):
        """不启动浏览器，只执行源码、画质加载和异步销毁契约。"""
        result = subprocess.run([NODE_BIN, '--test', '_studio/tooling/tests/ui-components.test.mjs'],
                                cwd=PROJECT_ROOT, capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
