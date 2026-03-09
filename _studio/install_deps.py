"""
MAERS 项目 - 所需第三方库安装脚本
==============================================
经检查，本项目所有 Python 文件中，
唯一需要安装的第三方库如下：

  1. Pillow          —— 图片处理（缩略图、WebP 生成、EXIF 读取）
  2. pillow-avif-plugin  —— Pillow 的 AVIF 格式支持插件（用于转换为 .avif 格式）

其余均为 Python 内置标准库，无需安装。
"""

import subprocess
import sys
import importlib.util

PACKAGES = [
    ("Pillow",             "PIL"),
    ("pillow-avif-plugin", "pillow_avif"),
]

def is_installed(import_name):
    return importlib.util.find_spec(import_name) is not None

def install(package_name):
    print(f"  正在安装: {package_name} ...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", package_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        print(f"  ✅ 安装成功: {package_name}")
        return True
    except subprocess.CalledProcessError:
        print(f"  ❌ 安装失败: {package_name}（请检查网络或 pip 配置）")
        return False

def main():
    print("=" * 50)
    print("   MAERS 项目 - 安装第三方依赖库")
    print("=" * 50)
    print()

    success, failed, skipped = [], [], []

    for package_name, import_name in PACKAGES:
        if is_installed(import_name):
            print(f"  ⏭️  已安装，跳过: {package_name}")
            skipped.append(package_name)
        else:
            if install(package_name):
                success.append(package_name)
            else:
                failed.append(package_name)

    print()
    print("-" * 50)
    if skipped and not success and not failed:
        print("所有依赖均已就绪，无需重复安装！")
    else:
        print(f"完成：新安装 {len(success)} 个，跳过 {len(skipped)} 个，失败 {len(failed)} 个")
        if failed:
            print("以下库安装失败，请手动执行：")
            for f in failed:
                print(f"    pip install {f}")
        else:
            print("所有依赖均已就绪，可以正常运行项目！")

if __name__ == "__main__":
    main()
