const directory = require('../../utils/member-directory')
const coachAuthorization = require('../../utils/coach-authorization')
Page({
 data:{way:'choose',code:'',busy:false,looking:false,card:null,note:'',requestId:'',ticket:''},
 onLoad(q={}){const t=String(q.t||q.scene||q.ticket||'').trim();if(t){this.setData({ticket:t,way:'scan'});this.confirmTicket(t)}else if(q.way==='scan')this.scan()},
 chooseCode(){this.setData({way:'code',note:'',card:null})},onCode(e){this.setData({code:String((e&&e.detail&&e.detail.value)||'').toUpperCase()})},
 scan(){wx.scanCode({scanType:['qrCode'],success:a=>{const raw=String((a&&a.result)||'');const t=String((/t=([^&]+)/.exec(raw)||/ticket=([^&]+)/.exec(raw)||[])[1]||raw).trim();this.setData({way:'scan',ticket:t});this.confirmTicket(t)},fail:()=>wx.showToast({title:'没有扫到二维码，可以改用会员编号。',icon:'none'})})},
 async confirmTicket(t){this.setData({busy:true,note:''});try{const r=await directory.resolveTicket(t);if(!r||!r.ok)return this.setData({card:null,note:(r&&r.message)||directory.TEXTS.TICKET_EXPIRED});this.setData({card:r.card,requestId:directory.newRequestId('add')})}finally{this.setData({busy:false})}},
 async lookup(){const code=String(this.data.code||'').trim();if(!/^M[A-F0-9]{8}$/i.test(code))return wx.showToast({title:'请输入 M 开头的完整会员编号',icon:'none'});this.setData({busy:true,looking:true,note:''});try{const r=await directory.findByCode(code);if(!r||!r.ok)return this.setData({card:null,note:(r&&r.message)||directory.TEXTS.CONTACT_NOT_FOUND});this.setData({card:r.card,requestId:directory.newRequestId('add')})}finally{this.setData({busy:false,looking:false})}},
 async add(){if(this.data.busy||!this.data.card)return;this.setData({busy:true});try{const r=this.data.ticket?await directory.addByTicket(this.data.ticket,this.data.requestId):await directory.addByCode(this.data.code,this.data.requestId);if(!r||!r.ok)return wx.showModal({title:'没有添加成功',content:(r&&r.message)||'请稍后重试。',showCancel:false});wx.showToast({title:r.duplicated?directory.TEXTS.DUPLICATED:'已经加入会员列表',icon:'none'});try{await coachAuthorization.notePermissionChanged()}catch(error){}wx.navigateBack()}finally{this.setData({busy:false})}},
 cancel(){this.setData({card:null,note:'',ticket:'',code:''})}
 ,backToStudents(){wx.switchTab({url:'/pages/students/students'})}
})
