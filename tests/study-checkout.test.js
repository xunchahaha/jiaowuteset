const assert = require('node:assert/strict');
const { test } = require('node:test');
const study = require('../miniprogram/utils/study');

const RAW = [
  { key: 'course_10', price: 1390, credits: 10, kind: 'course', title: '10 门课' },
  { key: 'course_1', price: 150, credits: 1, kind: 'course', title: '1 门课' },
  { key: 'course_20', price: 2490, credits: 20, kind: 'course', title: '20 门课' },
  { key: 'tiku_100', price: 200, credits: 100, kind: 'tiku', title: '100 题' }
];
const PRODUCTS = study.decorateProducts(RAW);

test('套餐展示：按价格排序、过滤题库券、以「次」为单位', () => {
  assert.deepEqual(PRODUCTS.map(p => p.key), ['course_1', 'course_10', 'course_20']);
  assert.equal(PRODUCTS[1].priceText, '13.9');
  assert.equal(PRODUCTS[1].unitText, '¥1.39/次');
  assert.equal(PRODUCTS[0].unitText, '体验');
});

test('套餐展示：iOS 低于 1 元的档位不可用', () => {
  const list = study.decorateProducts([{ key: 'x', price: 50, credits: 1, kind: 'course' }], { ios: true, iosMinPrice: 100 });
  assert.equal(list[0].disabled, true);
});

test('套餐展示：下单关闭时全部不可选，标「暂不支持」，也不会被推荐', () => {
  const list = study.decorateProducts(RAW, { closed: true });
  assert.ok(list.every(p => p.disabled && p.disabledText === '暂不支持'));
  assert.equal(study.recommendProduct(list, 1), null);
});

test('推荐套餐：补齐缺口总价最低，同档最多连买 3 笔', () => {
  const pick = n => { const r = study.recommendProduct(PRODUCTS, n); return r.product.key + 'x' + r.times; };
  assert.equal(pick(1), 'course_1x1');
  assert.equal(pick(2), 'course_1x2');     // ¥3，而不是 ¥13.9
  assert.equal(pick(4), 'course_10x1');    // 小档要连买 4 笔，超上限
  assert.equal(pick(11), 'course_20x1');
  assert.equal(study.recommendProduct([], 1), null);
});

test('推荐套餐：有 2 次档时，「1 门课 + 答题」推荐一笔 2 次档，而不是连买两笔 1 次档', () => {
  const withSmall = study.decorateProducts([
    { key: 'course_1', price: 150, credits: 1, kind: 'course' },
    { key: 'course_2', price: 290, credits: 2, kind: 'course' },
    { key: 'course_5', price: 690, credits: 5, kind: 'course' },
    { key: 'course_10', price: 1390, credits: 10, kind: 'course' }
  ]);
  const pick = n => { const r = study.recommendProduct(withSmall, n); return r.product.key + 'x' + r.times; };
  assert.equal(pick(1), 'course_1x1');
  assert.equal(pick(2), 'course_2x1');     // ¥2.9 一笔，比 ¥1.5 ×2 便宜且只付一次
  assert.equal(pick(4), 'course_2x2');     // 2 门课 + 答题：¥5.8，比 5 次档 ¥6.9 便宜
  assert.equal(pick(5), 'course_5x1');
});

test('结算：余额够直接提交，开答题时每门课预留 2 次', () => {
  const p = study.checkoutPlan({ courseCount: 2, available: 10, answering: true, products: PRODUCTS });
  assert.equal(p.step, 'submit');
  assert.equal(p.reserve, 4);
  assert.equal(p.need, 4);
  assert.equal(p.estMin, 2);               // 都没答题：只扣刷课的 2 次
  assert.equal(p.estMax, 4);               // 都答了题：预留的 4 次全扣
});

test('结算：开答题时只够刷课部分不行，要把答题那份也补齐', () => {
  const on = study.checkoutPlan({ courseCount: 2, available: 2, answering: true, products: PRODUCTS });
  assert.equal(on.shortfall, 2);
  assert.equal(on.step, 'buy');
  assert.equal(on.product.key + 'x' + on.times, 'course_1x2');
  const off = study.checkoutPlan({ courseCount: 2, available: 2, answering: false, products: PRODUCTS });
  assert.equal(off.step, 'submit');        // 同样的余额，不开答题可以直接下单
  assert.equal(off.reserve, 2);
});

test('结算：开答题 + 老欠款 → 门槛 = 预留 + 欠款', () => {
  const p = study.checkoutPlan({ courseCount: 1, available: 2, debt: 1, answering: true, products: PRODUCTS });
  assert.equal(p.need, 3);
  assert.equal(p.shortfall, 1);
});

test('结算：不够 → 推荐套餐（含欠款）', () => {
  const p = study.checkoutPlan({ courseCount: 2, available: 1, debt: 1, products: PRODUCTS });
  assert.equal(p.need, 3);
  assert.equal(p.shortfall, 2);
  assert.equal(p.step, 'buy');
  assert.equal(p.product.key, 'course_1');
  assert.equal(p.times, 2);
});

test('结算：手动选档优先；没有可买商品 → blocked', () => {
  assert.equal(study.checkoutPlan({ courseCount: 3, available: 0, products: PRODUCTS, pickedKey: 'course_20' })
    .product.key, 'course_20');
  assert.equal(study.checkoutPlan({ courseCount: 1, available: 0, products: [] }).step, 'blocked');
});

test('任务消耗：开答题才计答题部分', () => {
  assert.deepEqual(study.taskCost({ doneCourses: 3, answeredDoneCourses: 2, useTiku: true }), { total: 5, done: 3, answered: 2 });
  assert.equal(study.taskCost({ doneCourses: 3, answeredDoneCourses: 2, useTiku: false }).total, 3);
});

test('格式化', () => {
  assert.equal(study.yuan(1390), '13.9');
  assert.equal(study.yuan(200), '2');
  assert.equal(study.maskPhone('13812341234'), '138****1234');
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  assert.equal(study.formatTime(new Date(2026, 9, 12, 9, 5).getTime(), now), '今天 09:05');
  assert.equal(study.formatTime(new Date(2026, 9, 1, 9, 5).getTime(), now), '10-01 09:05');
  assert.equal(study.formatTime(new Date(2025, 0, 2).getTime(), now), '2025-01-02');
});
