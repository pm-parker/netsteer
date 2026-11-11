name: Bug report / 使用问题
description: Something doesn't work as expected / 功能异常或误判
labels: [bug]
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened / 问题描述
      description: What did you do, what did you expect, what happened instead. 做了什么、期望什么、实际发生了什么。
      placeholder: |
        1. Installed v1.20.0 on ..., opened LuCI page ...
        2. Clicked ...
        3. Expected ... but got ...
    validations:
      required: true

  - type: textarea
    id: doctor
    attributes:
      label: netsteer-doctor output / 诊断输出
      description: |
        SSH to the router and run `netsteer-doctor`, paste the FULL output between the triple backticks.
        SSH 到路由器执行 `netsteer-doctor`，把完整输出粘贴在代码块里（包含版本/环境/SQM/观测面/场景引擎/配置十段信息，是定位问题的关键）。
        ```sh
        ssh root@192.168.11.1 netsteer-doctor
        ```
      placeholder: |
        ```
        == NetSteer Doctor ... ==
        [1] 版本
        ...
        VERDICT: ...
        ```
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Extra context / 补充信息
      description: Screenshots of the LuCI page, when it started, recent config changes, anything else. 页面截图、问题开始时间、近期改动等。
    validations:
      required: false
