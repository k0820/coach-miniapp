const { EXERCISES } = require('../../utils/constants')
const { getDB, saveDB } = require('../../utils/data-runtime')
const mutate = require('../../utils/mutate')
const builtinKey = (group, name) => `${group}::${name}`

Component({
  data:{groups:EXERCISES.map(x=>x.group),customGroups:EXERCISES.map(x=>x.group),customGroup:'肩',customGroupIndex:0,customValue:'',editingIndex:-1,editingBuiltinKey:'',group:EXERCISES[0].group,q:'',sections:[],flash:''},
  lifetimes:{attached(){this.refresh()}},
  methods:{
    refresh(){
      const q=this.data.q.trim(),custom=getDB().customExercises||[],overrides=new Map(custom.filter(x=>x.builtinKey).map((x,index)=>[x.builtinKey,{...x,customIndex:index}]))
      const sections=EXERCISES.filter(g=>g.group===this.data.group).map(g=>{const items=[];g.items.forEach((originalName,index)=>{const key=builtinKey(g.group,originalName),override=overrides.get(key);if(override&&override.hidden)return;items.push({key:`builtin-${g.group}-${index}`,name:override?override.name:originalName,group:override?override.group:g.group,isCustom:false,builtinKey:key,customIndex:override?override.customIndex:-1})});custom.forEach((x,index)=>{if(!x.builtinKey&&!x.hidden&&x.group===g.group)items.push({key:`custom-${x.id||index}`,name:x.name,group:x.group,isCustom:true,customIndex:index})});return{group:g.group,items:items.filter(x=>!q||x.name.includes(q))}}).filter(g=>g.items.length)
      this.setData({sections})
    },
    chooseGroup(e){const group=e.currentTarget.dataset.group;if(!this.data.groups.includes(group))return;this.setData({group,customGroup:group,customGroupIndex:this.data.customGroups.indexOf(group)},()=>this.refresh())},
    search(e){this.setData({q:e.detail.value},()=>this.refresh())},
    manageCustom(e){const item=e.currentTarget.dataset.item;if(!item)return;wx.showActionSheet({itemList:['编辑动作','删除动作'],success:r=>{if(r.tapIndex===0)this.startEditItem(item);if(r.tapIndex===1)this.deleteItem(item)}})},
    choose(e){const item=e.currentTarget.dataset.item;this.setData({flash:item.name});setTimeout(()=>{this.setData({flash:''});this.triggerEvent('choose',{name:item.name,group:item.group})},140)},
    customInput(e){this.setData({customValue:e.detail.value})},customGroup(e){const customGroupIndex=+e.detail.value;this.setData({customGroupIndex,customGroup:this.data.customGroups[customGroupIndex]})},
    startEditItem(item){const index=Number.isInteger(item.customIndex)?item.customIndex:-1,group=item.group,customGroupIndex=Math.max(0,this.data.customGroups.indexOf(group));this.setData({editingIndex:index,editingBuiltinKey:item.builtinKey||'',customValue:item.name,customGroup:group,customGroupIndex})},
    cancelEdit(){this.setData({editingIndex:-1,editingBuiltinKey:'',customValue:'',customGroup:'肩',customGroupIndex:0})},
    async addCustom(){
      const name=this.data.customValue.trim(),group=this.data.customGroup,index=this.data.editingIndex,key=this.data.editingBuiltinKey;if(!name)return wx.showToast({title:'请输入动作名称',icon:'none'})
      const db=getDB(),custom=db.customExercises||[],item=index>=0?custom[index]:null,editing=!!key||index>=0,duplicate=EXERCISES.some(x=>x.group===group&&x.items.includes(name)&&builtinKey(x.group,name)!==key)||custom.some((x,i)=>!x.hidden&&i!==index&&x.name===name&&x.group===group)
      if(duplicate)return wx.showToast({title:'动作库中已有同名动作',icon:'none'})
      const command=item?'updateCustomExercise':'createCustomExercise',payload=item?{customExerciseId:item.id,name,group,hidden:false}:{name,group,...(key?{builtinKey:key}:{})}
      const result=await mutate(command,payload,{key:`${command}:${item?item.id:(key||`${group}:${name}`)}`,local:()=>{if(item)Object.assign(custom[index],{name,group,hidden:false});else custom.push({id:key?`builtin-${key}`:undefined,name,group,...(key?{builtinKey:key}:{})});db.customExercises=custom;saveDB(db)}})
      if(!result||!result.ok)return wx.showToast({title:(result&&result.message)||'操作未完成',icon:'none'})
      if(!editing)this.triggerEvent('choose',{name,group})
      this.setData({group,editingIndex:-1,editingBuiltinKey:'',customValue:'',customGroup:group,customGroupIndex:this.data.customGroups.indexOf(group)},()=>this.refresh());wx.showToast({title:editing?'动作已修改':`已加入${group}动作库`,icon:'none'});return result
    },
    deleteItem(item){wx.showModal({title:item.isCustom?'删除自定义动作':'从动作库删除',content:`确定删除“${item.name}”吗？\n已经记录在历史课程里的内容不会改变。`,confirmColor:'#c7563d',success:async r=>{if(!r.confirm)return;const db=getDB(),custom=db.customExercises||[],existing=item.customIndex>=0?custom[item.customIndex]:null,command=existing?(item.builtinKey?'updateCustomExercise':'deleteCustomExercise'):'createCustomExercise',payload=existing?(item.builtinKey?{customExerciseId:existing.id,hidden:true}:{customExerciseId:existing.id}):{name:item.name,group:item.group,builtinKey:item.builtinKey,hidden:true};const result=await mutate(command,payload,{key:`removeExercise:${existing&&existing.id||item.builtinKey}`,local:()=>{if(existing&&item.builtinKey)existing.hidden=true;else if(existing)custom.splice(item.customIndex,1);else custom.push({id:`builtin-${item.builtinKey}`,name:item.name,group:item.group,builtinKey:item.builtinKey,hidden:true});db.customExercises=custom;saveDB(db)}});if(result&&result.ok){this.cancelEdit();this.refresh();wx.showToast({title:'已从动作库删除',icon:'none'})}else wx.showToast({title:(result&&result.message)||'操作未完成',icon:'none'})}})},
    deleteCustom(e){const index=+e.currentTarget.dataset.index,item=(getDB().customExercises||[])[index];if(item)this.deleteItem({name:item.name,group:item.group,isCustom:true,customIndex:index})}
  }
})
