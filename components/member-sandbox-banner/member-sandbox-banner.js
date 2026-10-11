const runtime=require('../../utils/data-runtime')
Component({data:{sandbox:false},lifetimes:{attached(){this.setData({sandbox:runtime.isSandbox()})}}})
