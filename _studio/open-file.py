
import os
import sys
import subprocess

def get_project_root():
    """
    Assumes this script is in `_studio`, so project root is one level up.
    """
    current_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(current_dir)

def index_files(root_path):
    """
    Walks the directory tree and returns a list of (filename, full_path).
    Skips common ignore directories like .git, node_modules, etc.
    """
    file_list = []
    ignore_dirs = {'.git', 'node_modules', '__pycache__', 'venv', '.idea', '.vscode', 'photos', 'data', 'ui', '说明', 'plugins'}
    
    print(f"正在索引文件: {root_path} ...")
    print(f"已忽略目录: {', '.join(sorted(ignore_dirs))}")
    
    for root, dirs, files in os.walk(root_path):
        # Filter out ignored directories
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        
        for file in files:
            full_path = os.path.join(root, file)
            file_list.append((file, full_path, os.path.relpath(full_path, root_path)))
            
    print(f"索引完成，共找到 {len(file_list)} 个文件。")
    return file_list

def open_file(path):
    """
    Opens the file with the default associated application.
    """
    try:
        os.startfile(path)
        print(f"✅ 已打开: {path}")
    except OSError as e:
        print(f"❌ 无法打开文件: {e}")

def main():
    root_path = get_project_root()
    all_files = index_files(root_path)
    
    print("\n💡 输入文件名（或部分）进行搜索。输入 'q' 或 'exit' 退出。")
    print("--------------------------------------------------")

    while True:
        try:
            query = input("\n🔍 搜索 > ").strip()
        except KeyboardInterrupt:
            print("\n再见！")
            break

        if not query:
            continue
            
        if query.lower() in ('q', 'exit'):
            break
            
        # Search logic: simple substring match, case-insensitive
        matches = []
        for name, full_path, rel_path in all_files:
            if query.lower() in name.lower():
                matches.append((name, full_path, rel_path))
        
        if len(matches) == 0:
            print("❌ 未找到匹配文件。")
        elif len(matches) == 1:
            # Exact match found
            target = matches[0]
            print(f"🎯 找到: {target[2]}")
            open_file(target[1])
        else:
            # Multiple matches
            print(f"found {len(matches)} matches:")
            
            # Limit display to 10
            display_limit = 20
            for i, (name, _, rel_path) in enumerate(matches[:display_limit]):
                print(f" [{i+1}] {rel_path}")
            
            if len(matches) > display_limit:
                print(f" ... (还有 {len(matches) - display_limit} 个结果)")
                
            choice = input(f"输入序号打开 (1-{min(len(matches), display_limit)})，或回车取消: ").strip()
            
            if choice.isdigit():
                idx = int(choice) - 1
                if 0 <= idx < len(matches):
                    open_file(matches[idx][1])
                else:
                    print("无效序号。")

if __name__ == "__main__":
    main()
