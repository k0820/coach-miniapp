// Formal UI write-surface map. This is an audit allow-list, not a generic write API.
const UI_COMMAND_BINDINGS = Object.freeze({
  saveSettings: ['pages/stats:setting', 'pages/stats:saveSettings'],
  createCustomExercise: ['components/exercise-picker:addCustom'],
  updateCustomExercise: ['components/exercise-picker:addCustom'],
  deleteCustomExercise: ['components/exercise-picker:deleteCustom'],
  createManualSale: ['pages/stats:saveSale'],
  updateManualSale: ['pages/stats:editSaleDate'],
  deleteManualSale: ['pages/stats:deleteSale'],
  createStudent: ['pages/students:persistStudent'],
  updateStudent: ['pages/students:persistStudent'],
  deleteStudent: ['pages/students:removeStudentData'],
  createPackage: ['pages/students:savePackage'],
  createCourseSale: ['pages/students:savePackage'],
  updateCourseSale: ['pages/students:persistSaleEditor', 'pages/stats:editSaleDate'],
  reverseCourseSale: ['pages/students:removePkg', 'pages/stats:deleteSale'],
  updatePackage: ['pages/students:savePackage'],
  deletePackage: ['pages/students:removePkg'],
  createBooking: ['components/booking-modal:confirm'],
  // ── M2 第四批：Sandbox 验收页（`pages/sandbox-shared-test`）也能发这两条 ——
  //    它是**唯一**能在一部手机上把 A/B 流程点完的临时入口，但仍走同一个统一写入口。
  setPackageShare: ['pages/students:setPackageShare', 'pages/sandbox-shared-test:share'],
  createSharedBooking: ['pages/students:bookShared', 'pages/sandbox-shared-test:book'],
  updateBookingContent: ['pages/session:saveDraft', 'pages/session:copySummary', 'pages/session:complete'],
  rescheduleBooking: ['pages/session:saveReschedule'],
  cancelBooking: ['pages/session:cancel'],
  completeBooking: ['pages/session:complete'],
  deleteCompletedBooking: ['pages/session:deleteCompleted'],
  markBookingNotHeld: ['pages/session:markNotHeld'],
  // ⭐ 2026-10-06：跨教练排课的出口从旧「多教练服务（授权）工作台」搬到**学员列表**里 ——
  //    给已添加的会员排课就是这个按钮（云端按授权记录终判，课时包在谁账里就扣谁的）。
  createAuthorizedBooking: ['pages/students:confirmBooking']
})

// ⭐⭐ 2026-10-06：这 5 条**授权命令不再有任何客户端出口**。
//    「谁能给这位会员上课」现在只由一件小事决定：**添加 / 删除联系人**。
//    服务端 `member-directory` 在建关系时直接写授权表（客户端提交不了 ownerCoachId / grant），
//    撤关系时直接撤授权 —— 授权从此是"关系的后果"，不再是"教练要手工点的一件事"。
// ⛔ 它们仍然留在 COMMANDS 白名单里（云端 handlers 还在提供，抢修通道与存量数据要用），
//    但**客户端永远不该主动发** ⇒ 这里显式登记，并让回归钉死「页面里一个字都不许出现」。
const SERVER_TRIGGERED_COMMANDS = Object.freeze([
  'grantMemberService', 'revokeMemberService', 'grantPackageTeaching', 'revokePackageTeaching', 'transferPackageManagement'
])

module.exports = { UI_COMMAND_BINDINGS, SERVER_TRIGGERED_COMMANDS }
