## 变更说明

（做了什么、为什么；触及审查发现时引用编号，如 F2）

## 关联 issue

Closes #N（无则写“无”）

## 证据清单

- [ ] 迭代期受影响检查全绿，冻结候选后 `pnpm verify:candidate` 全绿
- [ ] CI `verify` 工作流绿
- [ ] 新增行为有对应测试（docs/08 §1 测试层）
- [ ] 声明并完成适用的条件门：policy / isolation / compatibility / coverage / promotion（不适用则注明）
- [ ] 仅同步本变更影响的注册权威文档
- [ ] 未影子注册官方服务、未引入第二权威状态、未修改 Agent Loop

## 已知限制 / 后续

（无则写“无”）
