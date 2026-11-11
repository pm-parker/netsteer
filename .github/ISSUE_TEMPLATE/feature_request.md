name: Feature request / 功能建议
description: Suggest an idea / 新场景、新设备类型、新想法
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve / 解决什么问题
      description: What are you trying to achieve that NetSteer doesn't help with today? 今天想达成但 NetSteer 还做不到的事。
    validations:
      required: true

  - type: textarea
    id: device
    attributes:
      label: Your device & environment / 设备与环境
      description: Router model, OpenWrt version, bandwidth, typical usage (gaming? NAS? IPTV?). 路由器型号、OpenWrt 版本、带宽、典型用法。
    validations:
      required: false
