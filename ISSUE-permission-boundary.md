# 权限边界未强制生效，无沙箱机制（Security）

**问题：**
工作区/授权目录（additionalDirectories）边界只在逻辑层声明，未在文件系统访问层强制。实测（Windows）Agent 可对授权范围外的 `C:\Users\<user>\Desktop` 做枚举、读、写、删操作，默认 `bypassPermissions` 下无拦截，且无 OS 级沙箱兜底。权限边界形同虚设。

**复现：**
用 Proma 托管空白目录建会话（不授权桌面路径），完全自动模式下执行 `ls C:\Users\<user>\Desktop` 并写入/读取/删除测试文件，全部成功无拦截。

**根因：**
Agent 以当前用户权限直接运行，继承全部文件读写删能力；目录边界未接入文件系统访问控制，未拦截越界路径与只读枚举；无 cgroup/namespace/seccomp/AppContainer/Job Object 等沙箱；plan 模式只挡写命令，挡不住只读枚举与读文件。

**影响：**
可窃读授权外敏感文件、写入删除破坏数据，默认模式可达，按安全缺陷处理。

**环境：** Windows x64 · Proma 开源版 · 默认权限模式
