import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';

const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(sanitizeMiddleware);
    app.post('/echo', (req, res) => res.status(200).json(req.body));
    return app;
};

describe('sanitizeMiddleware', () => {
    it('strips mongo operator keys from the body', async () => {
        const res = await request(buildApp())
            .post('/echo')
            .send({ email: { $ne: null }, password: 'secret' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ email: {}, password: 'secret' });
    });

    it('strips dotted keys nested inside objects and arrays', async () => {
        const res = await request(buildApp())
            .post('/echo')
            .send({ items: [{ 'a.b': 1, keep: 2 }] });

        expect(res.body).toEqual({ items: [{ keep: 2 }] });
    });

    it('leaves clean payloads untouched', async () => {
        const payload = { fullName: 'Sachin', email: 'a@b.com' };
        const res = await request(buildApp()).post('/echo').send(payload);

        expect(res.body).toEqual(payload);
    });
});
